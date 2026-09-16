// opencode-workflow — server plugin.
//
// Registers the `workflow` tool (model-facing orchestration), keyword triggers
// ("run a workflow", "ultracode", ...), a system-prompt nudge so the model
// recommends workflows for large tasks, and live usage tracking for sub-agent
// child sessions.

import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { generateRunId, RunEngine } from "../runtime/engine.ts"
import { parseScript } from "../runtime/script.ts"
import { type AgentState, type RunState } from "../shared/state.ts"

const KEYWORD_RE =
  /\b(ultracode|run\s+a\s+workflow|start\s+(?:a\s+)?workflow|use\s+(?:a\s+)?workflow)\b/iu

const KEYWORD_DIRECTIVE =
  "[workflow requested] The user explicitly asked for workflow orchestration. Immediately call the `workflow` tool: author a script (must start with `export const meta = {...}`) that decomposes the request into phases and parallel agents, using agent()/parallel()/pipeline()/phase()/log(). Keep the plan proportional to the task."

const SYSTEM_GUIDANCE = `## Workflow orchestration
You have a \`workflow\` tool that fans a task out across many parallel sub-agents (50-100 in large runs) with phases, structured outputs, and a live progress view (/workflows).
Use it when:
- the user explicitly asks ("run a workflow", "ultracode", or the same in another language — the model decides), or
- the task is too large for one pass: it spans many files/modules, decomposes into parallel workstreams (audit, review, migration, research), or benefits from independent adversarial verification.
When the task seems large but the user did not ask: recommend a workflow in one or two sentences (scale + rough shape: phases and agent count) and wait for the go-ahead before calling the tool.
Do NOT use workflows for trivial or single-file tasks.
For script format (meta block, primitives, patterns), load the \`workflow-authoring\` skill if available.`

const TOOL_DESCRIPTION = `Run a multi-agent workflow: parallel sub-agents over phases with structured outputs, for tasks too large for one pass.
Args: one of \`script\` (inline JS workflow, must start with \`export const meta = { name, description, phases? }\`), \`scriptPath\` (file), or \`name\` (saved workflow in .opencode/workflows/). Optional \`args\` passed to the script.
The run starts in the background after the user approves the plan; a result turn is delivered when it finishes. The user can watch progress in /workflows (phases, per-agent model/tokens/time, stop/pause).
Use for: audits, multi-file migrations, code review across many files, research sweeps, anything parallelizable or needing independent verification.
Authoring guide: the workflow-authoring skill (load it first if available) documents agent()/parallel()/pipeline()/phase()/log(), schema-validated structured output, and quality patterns.`

type Client = NonNullable<PluginInput["client"]>

function modelLabel(providerID: string | undefined, id: string | undefined): string | undefined {
  if (!providerID || !id) return undefined
  return `${providerID}/${id}`
}

export default async (input: PluginInput): Promise<Hooks> => {
  const active = new Map<string, RunEngine>()
  const sessionModel = new Map<string, string>()
  const childSessionRun = new Map<string, string>()
  const childSessions = new Set<string>()

  const log = (level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => {
    try {
      input.client.app.log({ body: { level, service: "workflow", message, ...meta } }).catch(() => {})
    } catch {}
  }

  // Fetched lazily (first workflow call), never during plugin init:
  // awaiting a client call at init deadlocks against the server that is
  // still bootstrapping (it waits for plugins before serving HTTP).
  let modelsPromise: Promise<Set<string>> | undefined
  const fetchModels = (): Promise<Set<string>> => {
    modelsPromise ??= (async () => {
      const out = new Set<string>()
      try {
        const res: any = await Promise.race([
          input.client.config.providers(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("providers timeout")), 5000)),
        ])
        const data = res?.providers ?? res?.data?.providers ?? res ?? []
        for (const p of data) for (const m of Object.keys(p?.models ?? {})) out.add(`${p.id}/${m}`)
      } catch (e) {
        log("warn", `could not list models: ${errMsg(e)}`)
      }
      return out
    })()
    return modelsPromise
  }

  const opencodeDirOf = (worktree: string, directory: string): string =>
    existsSync(worktree) ? join(worktree, ".opencode") : join(directory, ".opencode")

  const preview = (args: { script?: string; scriptPath?: string; name?: string }): {
    name: string
    description: string
    phases: string[]
  } => {
      let raw = args.script
    if (!raw && args.scriptPath) {
      raw = readFileSync(args.scriptPath, "utf8")
    }
    if (!raw && args.name) {
      const bases = [join(input.directory, ".opencode", "workflows"), join(input.worktree, ".opencode", "workflows")]
      for (const base of bases) {
        for (const ext of [".js", ""]) {
          const p = join(base, `${safeName(args.name)}${ext}`)
          if (existsSync(p)) raw = readFileSync(p, "utf8")
        }
      }
    }
    if (!raw) throw new Error("no workflow script provided")
    const parsed = parseScript(raw)
    return {
      name: parsed.meta.name,
      description: parsed.meta.description,
      phases: (parsed.meta.phases ?? []).map((p) => p.title),
    }
  }

  const notifyMainSession = async (mainSessionID: string, res: { runId: string; status: string; name: string; error?: string; result?: string }): Promise<void> => {
    const lines: string[] = []
    lines.push(`Workflow run "${res.name}" finished with status: ${res.status}.`)
    if (res.error) lines.push(`Error: ${res.error}`)
    if (res.result) lines.push("", "Final result:", res.result)
    lines.push("", "Summarize the outcome for the user concisely (a few sentences). Full run details are available in /workflows.")
    try {
      await input.client.session.prompt({
        path: { id: mainSessionID },
        body: { parts: [{ type: "text", text: lines.join("\n") }] },
      })
    } catch (e) {
      log("warn", `could not deliver workflow result to session: ${errMsg(e)}`)
    }
  }

  const workflowTool = tool({
    description: TOOL_DESCRIPTION,
    args: {
      script: tool.schema.string().optional().describe("Inline workflow script (must start with `export const meta = { name, description, phases? }`)"),
      scriptPath: tool.schema.string().optional().describe("Path to a workflow script file"),
      name: tool.schema.string().optional().describe("Saved workflow name (.opencode/workflows/<name>.js)"),
      args: tool.schema.any().optional().describe("Value passed to the script as global `args` (real JSON, not a stringified list)"),
    },
    execute: async (args, ctx) => {
      if (!args.script && !args.scriptPath && !args.name)
        return { title: "workflow: missing input", output: "Provide one of: script (inline), scriptPath, or name (saved workflow)." }

      let plan: { name: string; description: string; phases: string[] }
      try {
        plan = preview(args)
      } catch (e: any) {
        return { title: "workflow: invalid script", output: `Could not parse workflow: ${e?.message ?? e}` }
      }

      const runId = generateRunId()
      const availableModels = await fetchModels()
      const engine = new RunEngine(
        {
          client: input.client as any,
          opencodeDir: opencodeDirOf(input.worktree, ctx.directory),
          mainSessionID: ctx.sessionID,
          defaultModel: sessionModel.get(ctx.sessionID),
          availableModels,
          runArgs: args.args,
          onChildSession: (agentId, sessionId) => {
            childSessions.add(sessionId)
            childSessionRun.set(sessionId, runId)
          },
          log,
        },
        runId,
      )
      active.set(runId, engine)

      // Plan approval through the standard permission flow.
      await ctx.ask({
        permission: "workflow",
        patterns: [plan.name],
        always: [plan.name],
        metadata: {
          description: plan.description,
          phases: plan.phases,
          runId,
          hint: "workflow plan approval — phases shown; use /workflows to watch progress",
        },
      })

      engine
        .run({ script: args.script, scriptPath: args.scriptPath, name: args.name, args: args.args })
        .then((res) => {
          active.delete(runId)
          for (const [sid, rid] of childSessionRun) if (rid === runId) childSessionRun.delete(sid)
          notifyMainSession(ctx.sessionID, res)
        })
        .catch((e) => {
          active.delete(runId)
          log("error", `workflow run ${runId} crashed: ${errMsg(e)}`)
        })

      return {
        title: `workflow: ${plan.name} started`,
        output: `Workflow "${plan.name}" is now running (runId ${runId}). Phases: ${plan.phases.join(" → ") || "auto"}. The user can watch progress, pause, or stop it in /workflows. A result turn will arrive automatically when the run finishes — do not poll.`,
        metadata: { runId },
      }
    },
  })

  return {
    tool: { workflow: workflowTool },

    "chat.params": async (i) => {
      const label = modelLabel(i.model?.providerID, i.model?.id)
      if (label && !childSessions.has(i.sessionID)) sessionModel.set(i.sessionID, label)
    },

    "chat.message": async (i, o) => {
      if (childSessions.has(i.sessionID)) return
      const text = (o.parts ?? []).map((p) => (p as any).type === "text" ? (p as any).text ?? "" : "").join("\n")
      if (KEYWORD_RE.test(text)) {
        o.parts.push({
          type: "text",
          text: KEYWORD_DIRECTIVE,
          id: `prt_workflow_request_${Math.random().toString(36).slice(2, 8)}`,
        } as any)
      }
    },

    "experimental.chat.system.transform": async (i, o) => {
      if (i.sessionID && childSessions.has(i.sessionID)) return
      o.system.push(SYSTEM_GUIDANCE)
    },

    event: async ({ event }) => {
      const e = event as any
      if (e?.type === "message.part.updated") {
        const part = e.properties?.part
        const runId = part?.sessionID ? childSessionRun.get(part.sessionID) : undefined
        if (runId) active.get(runId)?.onPartUpdated(part)
      }
      if (e?.type === "message.updated") {
        const m = e.properties?.info ?? e.properties?.message ?? (e.properties?.id ? e.properties : undefined)
        const runId = m?.sessionID ? childSessionRun.get(m.sessionID) : undefined
        if (runId) active.get(runId)?.onMessageUpdated(m)
      }
    },

    dispose: async () => {
      // opencode is going away: close out live runs so their state files do
      // not claim "running" forever (the TUI would otherwise refuse to delete them)
      for (const engine of active.values()) {
        try {
          engine.shutdown("opencode exited while the workflow was running")
        } catch (e) {
          log("warn", `workflow shutdown failed: ${errMsg(e)}`)
        }
      }
      active.clear()
    },
  }
}

// --- small helpers -----------------------------------------------------------

function safeName(n: string): string {
  return n.replace(/[^a-zA-Z0-9_-]/g, "-")
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}
