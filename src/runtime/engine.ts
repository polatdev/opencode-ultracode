// Workflow engine: runs a parsed workflow script against the opencode SDK.
// Deterministic-ish sandbox (see script.ts), concurrency pool, live state
// writing to /tmp/opencode-workflows/<project>/<runId>/state.json, pause/stop control.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { cpus } from "node:os"
import { join } from "node:path"
import {
  type AgentState,
  type AgentStatus,
  type RunState,
  type RunStatus,
  controlPath,
  journalPath,
  runDir,
  statePath,
} from "../shared/state.ts"
import { extractJson, validateSchema } from "./schema.ts"
import { buildScriptFunction, parseScript, type AgentOpts, type Primitives } from "./script.ts"

export interface EngineClient {
  session: {
    create(args: { body: { parentID?: string; title?: string } }): Promise<any>
    prompt(args: { path: { id: string }; body: any }): Promise<any>
    abort(args: { path: { id: string } }): Promise<any>
  }
}

export interface EngineDeps {
  client: EngineClient
  /** absolute path to the project's .opencode dir (saved workflows live in <dir>/workflows) */
  opencodeDir: string
  /** absolute directory that holds one folder per run (see runsRoot() in shared/state.ts) */
  runsRoot: string
  mainSessionID: string
  defaultModel?: string
  availableModels: Set<string>
  runArgs?: any
  /** called when a child session is created for an agent (agentId, sessionId) */
  onChildSession?: (agentId: string, sessionId: string) => void
  log?: (level: "debug" | "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) => void
}

export interface RunOptions {
  script?: string
  scriptPath?: string
  name?: string
  args?: any
  budgetTotal?: number | null
}

export class RunAbortedError extends Error {
  constructor() {
    super("workflow run was stopped")
  }
}

interface ModelRef {
  providerID: string
  modelID: string
  label: string
}

export function generateRunId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `run_${ts}${rand}`
}

export class RunEngine {
  state!: RunState
  private stopRequested = false
  private paused = false
  private flushTimer: any = null
  private flushScheduled = false
  private heartbeat: any = null
  private controlTimer: any = null
  private agentSeq = 0
  private sessionToAgent = new Map<string, string>()
  private sessionMsgTotals = new Map<string, Map<string, { t: number; o: number; c: number }>>()
  private lastTextPart = new Map<string, string>()
  private sem = 0
  private semMax: number
  private waiters: Array<() => void> = []
  private stoppedAgents = new Set<string>()
  private startedAt: number
  private resolveModelLabel: (m: ModelRef) => string

  private deps: EngineDeps
  private runId: string
  constructor(deps: EngineDeps, runId: string) {
    this.deps = deps
    this.runId = runId
    this.semMax = Math.max(1, Math.min(16, (cpus()?.length ?? 4) - 2))
    this.startedAt = Date.now()
    this.resolveModelLabel = (m) => `${m.providerID}/${m.modelID}`
  }

  get runDir() {
    return runDir(this.deps.runsRoot, this.runId)
  }

  registerSession(agentId: string, sessionId: string) {
    this.sessionToAgent.set(sessionId, agentId)
  }

  // --- public API used by the server plugin -------------------------------
  // Token/cost accounting is per assistant message (deduped by message id):
  // bus `message.updated` events stream it live, and the final prompt response
  // records the last message (same id → overwrite, no double count). Bus
  // `message.part.updated` events drive LIVE tool activity (onPartUpdated).
  onMessageUpdated(msg: any): void {
    this.recordMessage(msg)
  }

  recordMessage(msg: any): void {
    if (!msg || typeof msg.id !== "string" || !msg.sessionID) return
    if (msg.role && msg.role !== "assistant") return
    const agentId = this.sessionToAgent.get(msg.sessionID)
    if (!agentId) return
    const a = this.state.agents[agentId]
    if (!a) return
    const tk = tokenTotal(msg.tokens)
    const entry = { t: Math.max(0, tk | 0), o: Math.max(0, Number(msg.tokens?.output ?? 0) | 0), c: typeof msg.cost === "number" ? msg.cost : 0 }
    const per = this.sessionMsgTotals.get(msg.sessionID) ?? new Map<string, { t: number; o: number; c: number }>()
    const prev = per.get(msg.id)
    if (prev && prev.t === entry.t && prev.o === entry.o && prev.c === entry.c) return
    per.set(msg.id, entry)
    this.sessionMsgTotals.set(msg.sessionID, per)
    let T = 0
    let O = 0
    let C = 0
    for (const e of per.values()) {
      T += e.t
      O += e.o
      C += e.c
    }
    a.tokens = T
    a.outputTokens = O
    a.cost = C
    this.recount()
    this.markDirty()
  }

  onPartUpdated(part: any): void {
    const agentId = this.sessionToAgent.get(part?.sessionID)
    if (!agentId) return
    const a = this.state.agents[agentId]
    if (!a) return
    if (part?.type === "text" || part?.type === "reasoning") {
      const txt = typeof part?.text === "string" ? part.text : ""
      if (!txt.trim()) return
      a.liveText = txt.slice(-800)
      const pid = typeof part?.id === "string" ? part.id : ""
      if (pid !== this.lastTextPart.get(agentId)) {
        this.lastTextPart.set(agentId, pid)
        this.pushLiveFeed(a, "text", txt)
      } else {
        // same part still streaming: refresh the newest feed line in place
        const f = a.liveFeed?.[a.liveFeed.length - 1]
        if (f && f.kind === "text") f.text = txt.trim().replace(/\s+/g, " ").slice(0, 160)
      }
      this.markDirty()
      return
    }
    if (part?.type !== "tool") return
    const st = part.state
    const callId = typeof part?.callID === "string" ? part.callID : typeof part?.id === "string" ? part.id : undefined
    // match the open activity entry by call id first; fall back to "latest
    // open entry of the same tool" for hosts that do not send ids
    const existing =
      (callId && a.activity.find((x) => x.callId === callId)) ||
      a.activity.find((x) => !x.callId && x.tool === part.tool && !x.endedAt)
    const title = toolTitle(part.tool, st)
    if (!existing) {
      a.activity.push({
        callId,
        tool: part.tool,
        title,
        preview: undefined,
        startedAt: Date.now(),
      })
      a.toolCalls = a.activity.length
      this.pushLiveFeed(a, "tool", `${part.tool} ${title !== part.tool ? title : ""}`)
      this.recount()
      this.markDirty()
      return
    }
    if (existing.title === existing.tool && title !== part.tool) existing.title = title
    if (!existing.endedAt && (st?.status === "completed" || st?.status === "error")) {
      existing.endedAt = Date.now()
      existing.preview = truncate(String(st?.output ?? st?.error ?? ""), 300)
      const tail = st?.status === "error" ? `failed · ${oneLine(String(st?.error ?? ""))}` : "done"
      this.pushLiveFeed(a, "tool", `${existing.tool} ${tail} · ${existing.title !== existing.tool ? existing.title : ""}`)
      this.markDirty()
    } else {
      this.markDirty()
    }
  }

  private pushLiveFeed(a: AgentState, kind: "text" | "tool", text: string): void {
    const line = String(text ?? "").trim().replace(/\s+/g, " ").slice(0, 160)
    if (!line) return
    const feed = a.liveFeed ?? (a.liveFeed = [])
    feed.push({ at: Date.now(), kind, text: line })
    while (feed.length > 10) feed.shift()
  }

  // --- run lifecycle -------------------------------------------------------

  async run(opts: RunOptions): Promise<{ runId: string; status: RunStatus; name: string; error?: string; result?: string }> {
    mkdirSync(this.runDir, { recursive: true })
    const parsed = this.resolveScript(opts)
    const meta = parsed.meta
    const total = countAgents(meta)

    this.state = {
      runId: this.runId,
      status: "running",
      name: meta.name,
      description: meta.description,
      whenToUse: meta.whenToUse,
      phases: (meta.phases ?? []).map((p: any, i: number) => ({ ...p, index: i + 1, agentIds: [], done: 0 })),
      agents: {},
      agentOrder: [],
      logs: [],
      agentCount: 0,
      agentDone: 0,
      startedAt: this.startedAt,
      totalTokens: 0,
      totalCost: 0,
      scriptPath: opts.scriptPath ?? (opts.name ? this.findSavedScript(opts.name) : undefined),
      directory: join(this.deps.opencodeDir, ".."),
    }
    this.writeJournal({ type: "run-start", runId: this.runId, name: meta.name, agentEstimate: total, at: this.startedAt })
    this.flushNow()

    this.heartbeat = setInterval(() => this.markDirty(), 2000)
    this.controlTimer = setInterval(() => this.pollControl(), 300)

    try {
      this.deps.runArgs = opts.args
      const fn = buildScriptFunction(this.primitives(opts.budgetTotal ?? null), parsed.body)
      const result = await fn()
      this.finish(meta, this.stopRequested ? "stopped" : "completed", undefined, result)
    } catch (e: any) {
      const stopped = this.stopRequested
      this.finish(meta, stopped ? "stopped" : "failed", stopped ? undefined : (e?.message ?? String(e)), undefined, stopped ? undefined : e)
    } finally {
      this.cleanupTimers()
      this.flushNow()
    }
    return {
      runId: this.runId,
      status: this.state.status,
      name: meta.name,
      error: this.state.error,
      result: this.state.result,
    }
  }

  private finish(meta: { name: string; description: string }, status: RunStatus, error?: string, result?: any, rawError?: unknown): void {
    this.state.status = status
    this.state.endedAt = Date.now()
    this.state.error = this.state.error ?? error
    if (result !== undefined) {
      this.state.result = truncate(typeof result === "string" ? result : JSON.stringify(result, null, 2), 200_000)
    }
    this.logLine(status, error ? `failed: ${error}` : "completed")
    this.writeJournal({ type: "run-end", runId: this.runId, status, at: Date.now() })
    this.deps.log?.(status === "failed" ? "error" : "info", `workflow ${meta.name}: ${status}`, {
      runId: this.runId,
      agents: this.state.agentCount,
      tokens: this.state.totalTokens,
      error: rawError ? String(rawError) : undefined,
    })
  }

  private budgetTotal: number | null = null
  private primitives(budgetTotal: number | null): Primitives {
    this.budgetTotal = budgetTotal
    return {
      agent: (prompt, opts) => this.spawnAgent(prompt, opts ?? {}),
      parallel: (thunks) => this.parallel(thunks),
      pipeline: (items, ...stages) => this.pipeline(items, stages),
      phase: (title) => this.setPhase(title),
      log: (message) => this.logLine("log", String(message)),
      args: this.deps.runArgs,
      budget: {
        total: budgetTotal,
        spent: () => this.outputTokensSpent(),
        remaining: () => (budgetTotal == null ? Infinity : Math.max(0, budgetTotal - this.outputTokensSpent())),
      },
    }
  }

  // --- primitives ----------------------------------------------------------

  private currentPhase = ""

  private setPhase(title: string) {
    this.currentPhase = title
    if (!this.state.phases.find((p) => p.title === title)) {
      this.state.phases.push({ title, index: this.state.phases.length + 1, agentIds: [], done: 0 })
      this.recount()
    }
    this.markDirty()
  }

  private ensurePhase(title: string): number {
    let p = this.state.phases.find((x) => x.title === title)
    if (!p) {
      p = { title, index: this.state.phases.length + 1, agentIds: [], done: 0 }
      this.state.phases.push(p)
    }
    return p.index
  }

  private async parallel(thunks: Array<() => Promise<any>>): Promise<any[]> {
    if (!Array.isArray(thunks)) throw new Error("parallel() expects an array of thunks")
    if (thunks.length > 4096) throw new Error("parallel() accepts at most 4096 items")
    const out: any[] = new Array(thunks.length)
    await Promise.all(
      thunks.map(async (t, i) => {
        try {
          if (typeof t !== "function") throw new Error(`parallel(${i}) is not a thunk`)
          out[i] = await t()
        } catch (e) {
          this.logLine("log", `parallel item ${i} failed: ${errText(e)}`)
          out[i] = null
        }
      }),
    )
    return out
  }

  private async pipeline(items: any[], stages: Array<(prev: any, item: any, index: number) => Promise<any> | any>): Promise<any[]> {
    if (!Array.isArray(items)) throw new Error("pipeline() expects an items array")
    if (items.length > 4096) throw new Error("pipeline() accepts at most 4096 items")
    if (!stages.length) throw new Error("pipeline() needs at least one stage")
    const results = await Promise.all(
      items.map(async (item, index) => {
        let prev: any = null
        try {
          for (const stage of stages) prev = await stage(prev, item, index)
        } catch (e) {
          this.logLine("log", `pipeline item ${index} dropped: ${errText(e)}`)
          return null
        }
        return prev
      }),
    )
    return results
  }

  private async spawnAgent(prompt: string, opts: AgentOpts): Promise<any> {
    if (this.state.agentCount >= 1000) throw new Error("workflow agent cap (1000) reached")
    const total = this.budgetTotal
    if (total != null && this.outputTokensSpent() >= total)
      throw new Error("token budget exhausted; further agent() calls are blocked")

    this.agentSeq++
    const id = `ag-${String(this.agentSeq).padStart(3, "0")}`
    const label = opts.label ?? `agent-${this.agentSeq}`
    const phaseTitle = opts.phase ?? this.currentPhase ?? "main"
    const phaseIndex = this.ensurePhase(phaseTitle)
    if (this.currentPhase === "" && !opts.phase) this.currentPhase = phaseTitle

    const model = this.resolveModel(opts.model)
    const agent: AgentState = {
      id,
      label,
      phase: phaseTitle,
      phaseIndex,
      status: "queued",
      model: model ? this.resolveModelLabel(model) : this.deps.defaultModel ?? "default",
      tokens: 0,
      outputTokens: 0,
      cost: 0,
      toolCalls: 0,
      activity: [],
      prompt: String(prompt),
      sessionId: undefined,
    }
    this.state.agents[id] = agent
    this.state.agentOrder.push(id)
    this.state.phases.find((p) => p.title === phaseTitle)?.agentIds.push(id)
    this.state.agentCount++
    this.recount()
    this.markDirty()
    this.writeJournal({ type: "agent-start", id, label, phase: phaseTitle, at: Date.now() })

    await this.acquireSem()
    try {
      if (this.stopRequested) {
        agent.status = "cancelled"
        agent.error = "run stopped"
        this.onAgentTerminal(agent)
        return null
      }
      await this.waitIfPaused()
      if (this.stopRequested) {
        agent.status = "cancelled"
        agent.error = "run stopped"
        this.onAgentTerminal(agent)
        return null
      }
      agent.status = "running"
      agent.startedAt = Date.now()
      this.markDirty()

      const session = unwrap(await this.deps.client.session.create({
        body: { parentID: this.deps.mainSessionID, title: `wf/${this.state.name}/${label}` },
      }))
      agent.sessionId = session.id
      this.sessionToAgent.set(session.id, id)
      this.deps.onChildSession?.(id, session.id)

      let attempts = opts.schema ? 2 : 1
      let lastFailure = ""
      for (let attempt = 0; attempt < attempts; attempt++) {
        const body: any = {
          parts: [{ type: "text", text: this.subagentPrompt(prompt, phaseTitle, opts, attempt, lastFailure) }],
        }
        if (model) body.model = { providerID: model.providerID, modelID: model.modelID }
        const res = unwrap(await this.deps.client.session.prompt({ path: { id: session.id }, body }))
        const info = res?.info
        if (!info) throw new Error("empty session response")
        this.recordMessage(info)
        if (info.time?.completed) agent.endedAt = info.time.completed
        this.recount()
        this.markDirty()
        if (info.error) {
          throw new Error(typeof info.error === "string" ? info.error : info.error?.message ?? JSON.stringify(info.error))
        }
        const text = finalText(res?.parts)
        if (!opts.schema) {
          agent.outcomeText = truncate(text, 4000)
          return this.terminate(agent, "completed", text)
        }
        const ex = extractJson(text)
        if (!ex.ok) {
          lastFailure = `previous response was not valid JSON: ${ex.error}`
          agent.activity.push({ tool: "StructuredOutput", title: "invalid output", preview: ex.error, startedAt: Date.now(), endedAt: Date.now() })
          this.markDirty()
          continue
        }
        try {
          validateSchema(ex.value, opts.schema)
          agent.outcome = ex.value
          agent.outcomeText = truncate(JSON.stringify(ex.value, null, 2), 4000)
          return this.terminate(agent, "completed", ex.value)
        } catch (e: any) {
          lastFailure = `previous JSON failed schema validation: ${e?.message ?? e}`
          continue
        }
      }
      agent.status = "failed"
      agent.error = `structured output failed after ${attempts} attempts (${lastFailure})`
      this.onAgentTerminal(agent)
      this.writeJournal({ type: "agent-done", id, status: "failed", error: agent.error, at: Date.now() })
      return null
    } catch (e: any) {
      if (this.stopRequested || (e instanceof RunAbortedError)) {
        agent.status = "cancelled"
        agent.error = "run stopped"
      } else {
        agent.status = "failed"
        agent.error = errText(e)
      }
      this.onAgentTerminal(agent)
      this.writeJournal({ type: "agent-done", id, status: agent.status, error: agent.error, at: Date.now() })
      return null
    } finally {
      this.releaseSem()
    }
  }

  private terminate(agent: AgentState, status: AgentStatus, value: any): any {
    agent.status = status
    agent.endedAt = Date.now()
    this.onAgentTerminal(agent)
    this.writeJournal({
      type: "agent-done",
      id: agent.id,
      status,
      result: truncate(JSON.stringify(value ?? null), 100_000),
      at: Date.now(),
    })
    return value
  }

  private onAgentTerminal(_agent: AgentState): void {
    this.recount()
    this.markDirty()
  }

  // --- model resolution -----------------------------------------------------

  private resolveModel(requested?: string): ModelRef | undefined {
    if (!requested) return this.parseModel(this.deps.defaultModel)
    const direct = this.parseModel(requested)
    if (direct) {
      if (this.deps.availableModels.has(`${direct.providerID}/${direct.modelID}`)) return direct
      // not in the known set: fall back to session model and note it
      this.logLine("log", `model "${requested}" not found in available models; using session model for agent`)
      return this.parseModel(this.deps.defaultModel)
    }
    // bare name: match any provider/modelID
    const hits: string[] = []
    for (const m of this.deps.availableModels) {
      const i = m.indexOf("/")
      if (m.slice(i + 1) === requested || m === requested) hits.push(m)
    }
    if (hits.length >= 1) return this.parseModel(hits[0])!
    this.logLine("log", `model "${requested}" not found; using session model for agent`)
    return this.parseModel(this.deps.defaultModel)
  }

  private parseModel(s?: string): ModelRef | undefined {
    if (!s) return undefined
    const i = s.indexOf("/")
    if (i <= 0 || i === s.length - 1) return undefined
    return { providerID: s.slice(0, i), modelID: s.slice(i + 1), label: s }
  }

  // --- prompting -------------------------------------------------------------

  private subagentPrompt(prompt: string, phase: string, opts: AgentOpts, attempt: number, lastFailure: string): string {
    const parts: string[] = []
    parts.push(`You are a sub-agent of a workflow run (workflow "${this.state.name}", phase "${phase}").`)
    parts.push("Your final message text is the machine return value of this task — treat it as data for the orchestrator, not a message to a human.")
    parts.push("- Be concise and factual. No conversational preamble, no summaries of what you did.")
    if (attempt > 0 && lastFailure) {
      parts.push("")
      parts.push(`IMPORTANT: your previous attempt was rejected — ${lastFailure}. This time respond correctly.`)
    }
    if (opts.schema) {
      parts.push("")
      parts.push("Respond with ONLY a single JSON object that matches this JSON Schema exactly. No markdown fences, no text before or after:")
      parts.push(JSON.stringify(opts.schema))
    } else {
      parts.push("")
      parts.push("Return the raw result text. If the result is code or JSON, a fenced block or bare value is fine.")
    }
    parts.push("")
    parts.push("--- TASK ---")
    parts.push(prompt)
    return parts.join("\n")
  }

  // --- control (pause / stop) -------------------------------------------------

  private pollControl(): void {
    const p = controlPath(this.deps.runsRoot, this.runId)
    let raw: string | undefined
    try {
      raw = readFileSync(p, "utf8")
    } catch {
      return
    }
    let ctl: any
    try {
      ctl = JSON.parse(raw)
    } catch {
      return
    }
    if (!ctl || typeof ctl !== "object") return
    // accept both shapes: {"stop":true} and {"action":"stop"}
    const wantStop = ctl.stop === true || ctl.action === "stop"
    const wantPause = ctl.pause === true || ctl.action === "pause"
    const wantResume = ctl.resume === true || ctl.action === "resume"
    try {
      rmSync(p, { force: true })
    } catch {}
    if (wantPause && !this.paused && !this.stopRequested) {
      this.paused = true
      this.state.status = "paused"
      this.logLine("log", "paused by user")
      this.markDirty()
    }
    if (wantResume && this.paused) {
      this.paused = false
      if (this.state.status === "paused") this.state.status = "running"
      this.logLine("log", "resumed by user")
      this.markDirty()
    }
    if (wantStop && !this.stopRequested) {
      this.stopRequested = true
      this.state.status = "running"
      this.logLine("log", "stop requested by user")
      this.markDirty()
      this.abortAll()
    }
  }

  private abortAll(): void {
    for (const a of Object.values(this.state.agents)) {
      if (a.status === "running" && a.sessionId) {
        this.stoppedAgents.add(a.id)
        this.deps.client.session
          .abort({ path: { id: a.sessionId } })
          .catch(() => {})
      }
    }
  }

  private async waitIfPaused(): Promise<void> {
    while (this.paused && !this.stopRequested) {
      await sleep(300)
    }
    if (this.stopRequested) throw new RunAbortedError()
  }

  // --- concurrency pool --------------------------------------------------------

  private acquireSem(): Promise<void> {
    if (this.sem < this.semMax) {
      this.sem++
      return Promise.resolve()
    }
    return new Promise((res) => this.waiters.push(res))
  }
  private releaseSem(): void {
    this.sem--
    const next = this.waiters.shift()
    if (next) {
      this.sem++
      next()
    }
  }

  private outputTokensSpent(): number {
    return Object.values(this.state.agents).reduce((s, a) => s + (a.outputTokens || 0), 0)
  }

  // --- state persistence ---------------------------------------------------------

  private recount(): void {
    for (const p of this.state.phases) {
      p.done = p.agentIds.filter((id) => {
        const a = this.state.agents[id]
        return a && a.status !== "queued" && a.status !== "running"
      }).length
    }
    const agents = Object.values(this.state.agents)
    this.state.agentCount = agents.length
    this.state.agentDone = agents.filter((a) => a.status !== "queued" && a.status !== "running").length
    this.state.totalTokens = agents.reduce((s, a) => s + (a.tokens || 0), 0)
    this.state.totalCost = agents.reduce((s, a) => s + (a.cost || 0), 0)
  }

  private markDirty(): void {
    if (this.flushScheduled || !this.state) return
    this.flushScheduled = true
    this.flushTimer = setTimeout(() => {
      this.flushScheduled = false
      this.flushTimer = null
      this.flushNow()
    }, 400)
  }

  flushNow(): void {
    if (!this.state) return
    try {
      mkdirSync(this.runDir, { recursive: true })
      writeFileSync(statePath(this.deps.runsRoot, this.runId), JSON.stringify(this.state, null, 2))
    } catch (e: any) {
      this.deps.log?.("error", `workflow state write failed: ${errText(e)}`)
    }
  }

  private writeJournal(entry: any): void {
    try {
      mkdirSync(this.runDir, { recursive: true })
      appendFileSync(journalPath(this.deps.runsRoot, this.runId), JSON.stringify(entry) + "\n")
    } catch {}
  }

  private logLine(kind: string, message: string): void {
    this.state.logs.push({ at: Date.now(), message })
    if (this.state.logs.length > 200) this.state.logs.splice(0, this.state.logs.length - 200)
    this.deps.log?.("info", `[${this.state.name}] ${message}`)
    this.markDirty()
  }

  private resolveScript(opts: RunOptions): { meta: any; body: string; raw: string } {
    let script: string | undefined = opts.script
    if (!script && opts.scriptPath) script = readFileSync(opts.scriptPath, "utf8")
    if (!script && opts.name) {
      const p = this.findSavedScript(opts.name)
      if (p) script = readFileSync(p, "utf8")
      else throw new Error(`saved workflow "${opts.name}" not found (looked in .opencode/workflows and ~/.config/opencode/workflows)`)
    }
    if (!script) throw new Error("Workflow requires one of: script (inline), scriptPath, or name")
    const parsed = parseScript(script)
    try {
      writeFileSync(join(this.runDir, "script.js"), script)
    } catch {}
    return { ...parsed, raw: script }
  }

  findSavedScript(name: string): string | undefined {
    const candidates = [
      join(this.deps.opencodeDir, "workflows", `${safeName(name)}.js`),
      join(this.deps.opencodeDir, "workflows", `${safeName(name)}`),
    ]
    for (const c of candidates) if (existsSync(c) && statSync(c).isFile()) return c
    return undefined
  }

  /** host is shutting down: mark the run stopped so the TUI never shows a zombie "running" */
  shutdown(reason: string): void {
    if (!this.state) return
    if (this.state.status === "completed" || this.state.status === "failed" || this.state.status === "stopped") return
    this.stopRequested = true
    this.abortAll()
    for (const a of Object.values(this.state.agents)) {
      if (a.status === "running" || a.status === "queued") {
        a.status = "cancelled"
        a.error = reason
        a.endedAt = Date.now()
      }
    }
    this.recount()
    this.state.status = "stopped"
    this.state.endedAt = Date.now()
    this.state.error = this.state.error ?? reason
    this.logLine("stopped", reason)
    this.writeJournal({ type: "run-end", runId: this.runId, status: "stopped", at: Date.now(), reason })
    this.cleanupTimers()
    this.flushNow()
  }

  private cleanupTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.controlTimer) clearInterval(this.controlTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
  }
}

// --- helpers -----------------------------------------------------------------

function tokenTotal(t: any): number {
  if (!t) return 0
  return (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
}

function finalText(parts: any[]): string {
  if (!parts) return ""
  const texts: string[] = []
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p?.type === "text" && typeof p.text === "string") {
      texts.unshift(p.text)
    }
  }
  // last text part wins (final answer), fall back to all
  const last = texts.length ? texts[texts.length - 1] : ""
  return last.trim() || texts.join("\n")
}

function unwrap(res: any): any {
  if (res && typeof res === "object" && "data" in res) {
    const r = res as any
    if (r.error) {
      const msg = r.error?.data?.message ?? r.error?.message ?? "opencode API error"
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg))
    }
    return r.data
  }
  return res
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + `… [truncated ${s.length - n} chars]`
}

function errText(e: any): string {
  return e?.message ?? String(e)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function countAgents(meta: { phases?: any[] }): number {
  const fromPhases = (meta.phases ?? []).reduce((n, p: any) => n + (Array.isArray(p?.agentIds) ? p.agentIds.length : 0), 0)
  return fromPhases || (meta.phases?.length ?? 0)
}

function safeName(n: string): string {
  return n.replace(/[^a-zA-Z0-9_-]/g, "-")
}

export type { Primitives }

/** human title for a tool call: host title → recognisable input field → tool name */
function toolTitle(tool: string, st: any): string {
  const t = typeof st?.title === "string" ? st.title.trim() : ""
  if (t) return oneLine(t).slice(0, 120)
  const input = st?.input
  if (input && typeof input === "object") {
    for (const k of ["command", "filePath", "path", "pattern", "query", "url", "description", "prompt", "title"]) {
      const v = (input as any)[k]
      if (typeof v === "string" && v.trim()) return oneLine(v).slice(0, 120)
    }
    for (const v of Object.values(input)) if (typeof v === "string" && v.trim()) return oneLine(v).slice(0, 120)
  }
  return String(tool)
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}
