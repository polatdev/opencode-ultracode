// opencode-ultracode — server plugin.
//
// Registers the `workflow` tool (model-facing orchestration), keyword triggers
// ("run a workflow", "ultracode", ...), a system-prompt nudge so the model
// recommends workflows for large tasks, and live usage tracking for sub-agent
// child sessions.

import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { generateRunId, loadPriorRun, RunEngine } from "../runtime/engine.ts"
import { parseScript } from "../runtime/script.ts"
import { type AgentState, type RunState, controlPath, runsRoot } from "../shared/state.ts"

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
For script format (meta block, primitives, patterns), load the \`workflow-authoring\` skill (bundled with this plugin) before writing a script.`

const TOOL_DESCRIPTION = `Run a multi-agent workflow: parallel sub-agents over phases with structured outputs, for tasks too large for one pass.
Args: one of \`script\` (inline JS workflow, must start with \`export const meta = { name, description, phases? }\`), \`scriptPath\` (file), or \`name\` (saved workflow in .opencode/workflows/). Optional \`args\` passed to the script.
The run starts in the background after the user approves the plan; a result turn is delivered when it finishes. The user can watch progress in /workflows (phases, per-agent model/tokens/time, stop/pause).
\`resumeRunId\`: restart a run that was stopped or whose engine died (opencode exited while it ran). Completed agents replay from the journal; the rest run again. The user can also do this with \`p\` in /workflows.
Use for: audits, multi-file migrations, code review across many files, research sweeps, anything parallelizable or needing independent verification.
Authoring guide: the workflow-authoring skill (bundled with this plugin; load it first) documents agent()/parallel()/pipeline()/phase()/log(), schema-validated structured output, and quality patterns.`

// Skills shipped with the plugin (skills/<name>/SKILL.md next to src/). Registered
// through the `config` hook via `skills.paths`, so the model gets the
// workflow-authoring skill in every project without the user copying files
// into .opencode/skill or ~/.config/opencode/skill.
const BUNDLED_SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url))

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

  // Opt-in auto-approval of permission prompts raised by workflow sub-agents.
  // ULTRACODE_AUTO_ALLOW=1|true|all approves every permission a child session
  // asks for; a comma list ("bash,edit,webfetch") approves only those types.
  // Off by default: the project's permission config applies unchanged.
  const autoAllow = parseAutoAllow(process.env.ULTRACODE_AUTO_ALLOW)

  // Sessions opened *by* sub-agents (a task / sub-agent tool used inside a
  // workflow agent) are workflow sessions too. They are picked up from
  // session events; when a permission arrives before the event did, the
  // parentID chain is walked through the API instead. Both paths memoize.
  const descendantSessions = new Set<string>()
  const parentOf = new Map<string, string | undefined>()
  const isTracked = (id: string): boolean => childSessions.has(id) || descendantSessions.has(id)
  const noteSession = (info: { id?: string; parentID?: string } | undefined): void => {
    if (!info?.id) return
    parentOf.set(info.id, info.parentID)
    if (info.parentID && isTracked(info.parentID)) descendantSessions.add(info.id)
  }
  const isWorkflowSession = async (sessionID: string): Promise<boolean> => {
    if (isTracked(sessionID)) return true
    const chain: string[] = []
    let id: string | undefined = sessionID
    while (id && chain.length < 16 && !chain.includes(id)) {
      chain.push(id)
      if (!parentOf.has(id)) {
        try {
          const res: any = await input.client.session.get({ path: { id } })
          const info = res?.data ?? res
          parentOf.set(id, typeof info?.parentID === "string" ? info.parentID : undefined)
        } catch {
          return false
        }
      }
      const parent: string | undefined = parentOf.get(id)
      if (!parent) return false
      if (isTracked(parent)) {
        for (const s of chain) descendantSessions.add(s)
        return true
      }
      id = parent
    }
    return false
  }

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

  const projectRootOf = (worktree: string, directory: string): string =>
    existsSync(worktree) ? worktree : directory
  const opencodeDirOf = (worktree: string, directory: string): string =>
    join(projectRootOf(worktree, directory), ".opencode")

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

  const runsRootHere = () => runsRoot(projectRootOf(input.worktree, input.directory))

  /**
   * Restart a run in place: same runId, same script, completed agents replayed
   * from journal.jsonl. Used by the TUI (control.json {action:"resume"} on a run
   * with no live engine) and by the tool's `resumeRunId`.
   */
  const resumeRun = async (
    runId: string,
    opts: { runsRoot: string; notifySessionID?: string },
  ): Promise<{ ok: true; name: string; replayable: number } | { ok: false; reason: string }> => {
    if (active.has(runId)) return { ok: false, reason: "run is already live in this opencode" }
    const prior = loadPriorRun(opts.runsRoot, runId)
    if (!prior) return { ok: false, reason: "no state.json/script.js for that run" }
    if (prior.state.status === "completed") return { ok: false, reason: "run already completed" }
    const mainSessionID = prior.state.mainSessionID ?? opts.notifySessionID ?? ""
    const availableModels = await fetchModels()
    const engine = new RunEngine(
      {
        client: input.client as any,
        opencodeDir: join(prior.state.directory || projectRootOf(input.worktree, input.directory), ".opencode"),
        runsRoot: opts.runsRoot,
        mainSessionID,
        defaultModel: prior.state.defaultModel ?? (mainSessionID ? sessionModel.get(mainSessionID) : undefined),
        availableModels,
        runArgs: prior.state.args,
        onChildSession: (_agentId, sessionId) => {
          childSessions.add(sessionId)
          childSessionRun.set(sessionId, runId)
        },
        log,
      },
      runId,
    )
    active.set(runId, engine)
    log("info", `resuming workflow run ${runId} (${prior.replayable} agents replay)`)
    engine
      .run({ resume: prior })
      .then((res) => {
        active.delete(runId)
        for (const [sid, rid] of childSessionRun) if (rid === runId) childSessionRun.delete(sid)
        const target = opts.notifySessionID ?? prior.state.mainSessionID
        if (target) notifyMainSession(target, res)
      })
      .catch((e) => {
        active.delete(runId)
        log("error", `resumed workflow run ${runId} crashed: ${errMsg(e)}`)
      })
    return { ok: true, name: prior.state.name, replayable: prior.replayable }
  }

  // The TUI can only write files. A live engine consumes its own control.json;
  // a control file next to a run with NO engine in this process is a request
  // aimed at us: "resume" restarts the run, anything else is stale and dropped.
  const pollOrphanControls = () => {
    let names: string[]
    const root = runsRootHere()
    try {
      names = readdirSync(root).filter((n) => n.startsWith("run_"))
    } catch {
      return
    }
    for (const runId of names) {
      if (active.has(runId)) continue
      const cp = controlPath(root, runId)
      let ctl: any
      try {
        if (!existsSync(cp)) continue
        ctl = JSON.parse(readFileSync(cp, "utf8"))
      } catch {
        continue
      }
      try {
        rmSync(cp, { force: true })
      } catch {}
      const wantResume = ctl?.action === "resume" || ctl?.resume === true
      if (!wantResume) continue
      resumeRun(runId, { runsRoot: root })
        .then((r) => {
          if (!r.ok) log("warn", `cannot resume ${runId}: ${r.reason}`)
        })
        .catch((e) => log("error", `resume ${runId} failed: ${errMsg(e)}`))
    }
  }
  const orphanTimer = setInterval(pollOrphanControls, 1000)

  const workflowTool = tool({
    description: TOOL_DESCRIPTION,
    args: {
      script: tool.schema.string().optional().describe("Inline workflow script (must start with `export const meta = { name, description, phases? }`)"),
      scriptPath: tool.schema.string().optional().describe("Path to a workflow script file"),
      name: tool.schema.string().optional().describe("Saved workflow name (.opencode/workflows/<name>.js)"),
      args: tool.schema.any().optional().describe("Value passed to the script as global `args` (real JSON, not a stringified list)"),
      resumeRunId: tool.schema.string().optional().describe("Resume a stopped run (its engine died) by runId: completed agents replay, the rest run again"),
    },
    execute: async (args, ctx) => {
      if (args.resumeRunId) {
        const r = await resumeRun(args.resumeRunId, {
          runsRoot: runsRoot(projectRootOf(input.worktree, ctx.directory)),
          notifySessionID: ctx.sessionID,
        })
        if (!r.ok) return { title: "workflow: cannot resume", output: `Run ${args.resumeRunId} cannot be resumed: ${r.reason}` }
        return {
          title: `workflow: ${r.name} resumed`,
          output: `Workflow "${r.name}" resumed (runId ${args.resumeRunId}); ${r.replayable} completed agent(s) replay from the journal, the rest run again. A result turn will arrive automatically when it finishes — do not poll.`,
          metadata: { runId: args.resumeRunId },
        }
      }
      if (!args.script && !args.scriptPath && !args.name)
        return { title: "workflow: missing input", output: "Provide one of: script (inline), scriptPath, name (saved workflow), or resumeRunId." }

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
          runsRoot: runsRoot(projectRootOf(input.worktree, ctx.directory)),
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

    // Runs once at startup with the merged config object that opencode later
    // hands to skill discovery, so pushing here is enough to make the bundled
    // skills visible in this and every other project the plugin is loaded in.
    config: async (cfg) => {
      let isDir = false
      try {
        isDir = statSync(BUNDLED_SKILLS_DIR).isDirectory()
      } catch {}
      if (!isDir) {
        log("warn", "bundled skills directory missing; workflow-authoring skill unavailable", { dir: BUNDLED_SKILLS_DIR })
        return
      }
      const c = cfg as { skills?: { paths?: string[]; urls?: string[] } }
      c.skills ??= {}
      c.skills.paths ??= []
      if (!c.skills.paths.includes(BUNDLED_SKILLS_DIR)) c.skills.paths.push(BUNDLED_SKILLS_DIR)
      log("debug", "registered bundled skills", { dir: BUNDLED_SKILLS_DIR })
    },

    "chat.params": async (i) => {
      const label = modelLabel(i.model?.providerID, i.model?.id)
      if (label && !childSessions.has(i.sessionID)) sessionModel.set(i.sessionID, label)
    },

    // With auto-allow on, permission prompts raised inside workflow child
    // sessions are approved here instead of reaching the user. The main
    // session (including the plan approval prompt) is never affected.
    "permission.ask": async (perm, output) => {
      if (!autoAllow) return
      if (!(await isWorkflowSession(perm.sessionID))) return
      if (autoAllow !== "all" && !autoAllow.has(perm.type)) return
      output.status = "allow"
      log("info", `auto-allowed ${perm.type} permission for workflow sub-agent`, {
        sessionID: perm.sessionID,
        pattern: Array.isArray(perm.pattern) ? perm.pattern.join(", ") : perm.pattern,
      })
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
      if (e?.type === "session.created" || e?.type === "session.updated") noteSession(e.properties?.info)
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
      clearInterval(orphanTimer)
      // opencode is going away: close out live runs so their state files do
      // not claim "running" forever (the TUI would otherwise refuse to delete them).
      // The run folder stays intact and can be resumed (p in /workflows).
      for (const engine of active.values()) {
        try {
          engine.shutdown("opencode exited while the workflow was running — press p in /workflows to resume")
        } catch (e) {
          log("warn", `workflow shutdown failed: ${errMsg(e)}`)
        }
      }
      active.clear()
    },
  }
}

// --- small helpers -----------------------------------------------------------

/** ULTRACODE_AUTO_ALLOW → false (off), "all", or the set of permission types to allow. */
function parseAutoAllow(raw: string | undefined): false | "all" | Set<string> {
  const v = (raw ?? "").trim().toLowerCase()
  if (!v || v === "0" || v === "false" || v === "off" || v === "no") return false
  if (v === "1" || v === "true" || v === "all" || v === "*" || v === "yes") return "all"
  const types = new Set(v.split(",").map((t) => t.trim()).filter(Boolean))
  return types.size ? types : false
}

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
