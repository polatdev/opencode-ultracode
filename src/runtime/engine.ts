// Workflow engine: runs a parsed workflow script against the opencode SDK.
// Deterministic-ish sandbox (see script.ts), concurrency pool, live state
// writing to /tmp/opencode-workflows/<project>/<runId>/state.json, pause/stop control.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { cpus, hostname } from "node:os"
import { join } from "node:path"
import {
  type AgentState,
  type AgentStatus,
  type RunState,
  type RunStatus,
  controlPath,
  isSettled,
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
    /** optional: used on resume to check that an agent's earlier session still exists */
    get?(args: { path: { id: string } }): Promise<any>
  }
}

/** what the user (or the tool) asked an agent to do next */
type Decision = { kind: "retry"; note?: string } | { kind: "skip" }

/** why the next prompt to an agent is a follow-up rather than the task itself */
interface FollowUp {
  /** what went wrong with the previous attempt (error text), if anything */
  reason?: string
  /** free-text note from the user */
  note?: string
  /** true when the follow-up goes to a fresh session (the earlier one is gone): the full task is repeated */
  fresh: boolean
}

/**
 * ULTRACODE_HOLD_FAILED=0 restores the old behaviour: a failed agent hands
 * `null` to the script immediately instead of waiting for retry / skip.
 */
function holdFailedByDefault(): boolean {
  const v = (process.env.ULTRACODE_HOLD_FAILED ?? "").trim().toLowerCase()
  return !(v === "0" || v === "false" || v === "off" || v === "no")
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
  /**
   * Resume a run whose engine died (opencode exited/crashed, or it was stopped).
   * The engine must be constructed with the SAME runId. The prior script is
   * re-executed; every agent() whose (phase, label, prompt) matches a completed
   * agent of the prior run returns that agent's journaled result instantly and
   * is marked `replayed`. Everything else runs for real.
   */
  resume?: PriorRun
  /**
   * With `resume`: notes for agents of the prior run that should be retried,
   * keyed by that run's agent id. The agent continues in its own session with
   * the note (see FollowUp).
   */
  retryNotes?: Record<string, string>
}

/** what loadPriorRun() recovers from a run folder for a resume */
export interface PriorRun {
  state: RunState
  script: string
  /** replay key (see replayKey) -> journaled results + agent snapshots, in spawn order */
  replay: Map<string, Array<{ result: any; agent: AgentState }>>
  /** completed agents that can be replayed */
  replayable: number
  /**
   * replay key -> agents that did NOT complete but still have a session
   * (failed, cancelled, paused, or running when the engine died). A resumed
   * run continues them in that session instead of starting over.
   */
  continuable: Map<string, AgentState[]>
}

/** agents are matched across runs by where they ran and what they were asked */
function replayKey(phase: string, label: string, prompt: string): string {
  return `${phase}\u0000${label}\u0000${createHash("sha1").update(prompt).digest("hex")}`
}

/**
 * Read a finished/stopped run's folder so it can be resumed in place. Returns
 * undefined when the folder has no usable state or script. Results come from
 * journal.jsonl (`agent-done` entries carry the full value); the state file
 * supplies prompts and token/cost snapshots. A result that was truncated in
 * the journal is not replayable, so that agent simply runs again.
 */
export function loadPriorRun(runsRootDir: string, runId: string): PriorRun | undefined {
  let state: RunState
  let script: string
  try {
    state = JSON.parse(readFileSync(statePath(runsRootDir, runId), "utf8"))
    script = readFileSync(join(runDir(runsRootDir, runId), "script.js"), "utf8")
  } catch {
    return undefined
  }
  if (!state || typeof state !== "object" || !state.agents || !script) return undefined
  // The run directory IS the id. Older/copied state files can carry a different
  // runId; pin it to the directory so the resume identity is derivable from disk
  // and never depends on a value the caller happened to keep around.
  state.runId = runId
  const results = new Map<string, any>()
  try {
    for (const line of readFileSync(journalPath(runsRootDir, runId), "utf8").split("\n")) {
      if (!line) continue
      let e: any
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (e?.type !== "agent-done" || e.status !== "completed" || typeof e.result !== "string") continue
      try {
        results.set(e.id, JSON.parse(e.result))
      } catch {
        // truncated or otherwise unparsable → not replayable
      }
    }
  } catch {}
  const replay = new Map<string, Array<{ result: any; agent: AgentState }>>()
  const continuable = new Map<string, AgentState[]>()
  let replayable = 0
  for (const id of state.agentOrder ?? Object.keys(state.agents)) {
    const a = state.agents[id]
    if (!a) continue
    const key = replayKey(a.phase, a.label, a.prompt ?? "")
    if (a.status !== "completed") {
      if (a.sessionId) {
        const list = continuable.get(key) ?? []
        list.push(a)
        continuable.set(key, list)
      }
      continue
    }
    let result: any
    if (results.has(id)) result = results.get(id)
    else if (a.outcome !== undefined) result = a.outcome
    else continue
    const list = replay.get(key) ?? []
    list.push({ result, agent: a })
    replay.set(key, list)
    replayable++
  }
  return { state, script, replay, replayable, continuable }
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

/**
 * Run ids are time-sortable and collision-free: a millisecond timestamp plus 40
 * bits of CSPRNG entropy (Math.random gives no such guarantee, and two runs
 * started in the same millisecond used to be able to land on the same id).
 * The id is also recorded inside state.json as `runId`, so a resume can always
 * be derived from the state file instead of an out-of-band value.
 */
export function generateRunId(): string {
  const ts = Date.now().toString(36).padStart(9, "0")
  const rand = randomBytes(5).toString("hex")
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
  private sessionMsgTotals = new Map<string, Map<string, { t: number; o: number; c: number; ctx: number }>>()
  private lastTextPart = new Map<string, string>()
  private sem = 0
  private semMax: number
  private waiters: Array<() => void> = []
  /** agents the user stopped individually (X): abort, then hand null to the script */
  private stoppedAgents = new Set<string>()
  /** agents the user paused individually (P): abort, keep the session, wait for a decision */
  private pausedAgents = new Set<string>()
  /** retry / skip decisions waiting to be consumed by the agent's loop */
  private decisions = new Map<string, Decision>()
  /** token/cost totals an agent brought along from its earlier run (resume continues its session) */
  private carried = new Map<string, { t: number; o: number; c: number }>()
  private holdFailed = holdFailedByDefault()
  private replay: Map<string, Array<{ result: any; agent: AgentState }>> | undefined
  private continuable: Map<string, AgentState[]> | undefined
  private retryNotes: Record<string, string> = {}
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
    const entry = {
      t: Math.max(0, tk | 0),
      o: Math.max(0, Number(msg.tokens?.output ?? 0) | 0),
      c: typeof msg.cost === "number" ? msg.cost : 0,
      ctx: Math.max(0, contextTokens(msg.tokens) | 0),
    }
    const per = this.sessionMsgTotals.get(msg.sessionID) ?? new Map<string, { t: number; o: number; c: number; ctx: number }>()
    const prev = per.get(msg.id)
    if (prev && prev.t === entry.t && prev.o === entry.o && prev.c === entry.c && prev.ctx === entry.ctx) return
    per.set(msg.id, entry)
    this.sessionMsgTotals.set(msg.sessionID, per)
    // billed = sum over all calls; context = prompt size of the latest call
    // (message ids are time-ordered, so the greatest id is the newest call;
    // a still-streaming message may report 0 until the provider fills it in,
    // so keep the previous non-zero context in that case)
    const base = this.carried.get(agentId)
    let T = base?.t ?? 0
    let O = base?.o ?? 0
    let C = base?.c ?? 0
    let newestId = ""
    let ctx = 0
    for (const [id, e] of per) {
      T += e.t
      O += e.o
      C += e.c
      if (id > newestId && e.ctx > 0) {
        newestId = id
        ctx = e.ctx
      }
    }
    a.tokens = T
    a.outputTokens = O
    a.contextTokens = ctx
    a.cost = C
    this.recount()
    this.markDirty()
  }

  onPartUpdated(part: any): void {
    const agentId = this.sessionToAgent.get(part?.sessionID)
    if (!agentId) return
    const a = this.state.agents[agentId]
    if (!a) return
    if (part?.type === "reasoning") {
      this.onReasoningPart(a, part)
      return
    }
    if (part?.type === "text") {
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
      a.toolCalls = a.activity.filter((x) => x.kind !== "think").length
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

  /**
   * Thinking blocks become "think" activity rows: one per reasoning part,
   * matched by part id. The row's title is the first line of the thought
   * (empty when the provider hides the text), its duration comes from the
   * part's own time.start/time.end so it is exact even when events lag.
   */
  private onReasoningPart(a: AgentState, part: any): void {
    const pid = typeof part?.id === "string" ? part.id : undefined
    if (!pid) return
    const txt = typeof part?.text === "string" ? part.text : ""
    const start = typeof part?.time?.start === "number" ? part.time.start : Date.now()
    const end = typeof part?.time?.end === "number" ? part.time.end : undefined
    const title = oneLine(txt).slice(0, 120)
    const feedText = title ? `think · ${title}` : "think"
    let act = a.activity.find((x) => x.kind === "think" && x.callId === pid)
    if (!act) {
      act = { kind: "think", callId: pid, tool: "think", title, startedAt: start }
      a.activity.push(act)
      this.pushLiveFeed(a, "think", feedText)
    } else {
      if (title) act.title = title
      // keep the feed line for this thought fresh while the text streams
      const feed = a.liveFeed ?? []
      const f = [...feed].reverse().find((x) => x.kind === "think")
      if (f && !act.endedAt) f.text = feedLine(feedText)
    }
    if (txt.trim()) act.preview = truncate(txt, 300)
    if (end && !act.endedAt) {
      act.endedAt = end
      const feed = a.liveFeed ?? []
      const f = [...feed].reverse().find((x) => x.kind === "think")
      const dur = fmtSecs(end - act.startedAt)
      if (f) f.text = feedLine(act.title ? `think ${dur} · ${act.title}` : `think ${dur}`)
    }
    this.markDirty()
  }

  private pushLiveFeed(a: AgentState, kind: "text" | "tool" | "think", text: string): void {
    const line = feedLine(text)
    if (!line) return
    const feed = a.liveFeed ?? (a.liveFeed = [])
    feed.push({ at: Date.now(), kind, text: line })
    while (feed.length > 10) feed.shift()
  }

  // --- run lifecycle -------------------------------------------------------

  async run(opts: RunOptions): Promise<{ runId: string; status: RunStatus; name: string; error?: string; result?: string }> {
    mkdirSync(this.runDir, { recursive: true })
    const prior = opts.resume
    if (prior) {
      if (prior.state.runId !== this.runId) throw new Error(`resume: engine runId ${this.runId} does not match prior run ${prior.state.runId}`)
      opts = { ...opts, script: prior.script, scriptPath: undefined, name: undefined, args: opts.args ?? prior.state.args }
      this.replay = prior.replay
      this.continuable = prior.continuable
      this.retryNotes = opts.retryNotes ?? {}
      this.startedAt = prior.state.startedAt || this.startedAt
    }
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
      totalContextTokens: 0,
      totalCost: 0,
      scriptPath: opts.scriptPath ?? (opts.name ? this.findSavedScript(opts.name) : undefined),
      directory: join(this.deps.opencodeDir, ".."),
      mainSessionID: this.deps.mainSessionID || undefined,
      defaultModel: this.deps.defaultModel,
      args: opts.args,
      // liveness proof for readers (TUI): whoever finds this file can check the
      // pid instead of guessing from the file's age
      enginePid: process.pid,
      engineHost: hostname(),
      heartbeatAt: this.startedAt,
    }
    if (prior) {
      // keep the story of the run: earlier logs, then a marker for this resume
      this.state.logs = (prior.state.logs ?? []).slice(-150)
      this.state.scriptPath = prior.state.scriptPath
      this.state.resumedAt = Date.now()
      this.state.resumeCount = (prior.state.resumeCount ?? 0) + 1
      const cont = [...prior.continuable.values()].reduce((n, l) => n + l.length, 0)
      const notes = Object.keys(this.retryNotes).length
      this.logLine(
        "log",
        `resumed (${prior.replayable} completed agent${prior.replayable === 1 ? "" : "s"} replay from the journal` +
          (cont ? `, ${cont} continue in their own session${cont === 1 ? "" : "s"}` : "") +
          (notes ? `, ${notes} with a note from you` : "") +
          ")",
      )
      this.writeJournal({ type: "run-start", runId: this.runId, name: meta.name, agentEstimate: total, at: Date.now(), resumed: true, replayable: prior.replayable })
    } else {
      this.writeJournal({ type: "run-start", runId: this.runId, name: meta.name, agentEstimate: total, at: this.startedAt })
    }
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
      contextTokens: this.state.totalContextTokens,
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
      contextTokens: 0,
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

    const hit = this.takeReplay(phaseTitle, label, agent.prompt)
    if (hit) {
      const p = hit.agent
      agent.status = "completed"
      agent.replayed = true
      agent.model = p.model || agent.model
      agent.tokens = p.tokens || 0
      agent.contextTokens = p.contextTokens || 0
      agent.outputTokens = p.outputTokens || 0
      agent.cost = p.cost || 0
      agent.toolCalls = p.toolCalls || 0
      agent.activity = Array.isArray(p.activity) ? p.activity : []
      agent.outcome = p.outcome
      agent.outcomeText = p.outcomeText ?? truncate(typeof hit.result === "string" ? hit.result : JSON.stringify(hit.result, null, 2), 4000)
      agent.sessionId = p.sessionId
      agent.startedAt = p.startedAt
      agent.endedAt = p.endedAt ?? Date.now()
      this.onAgentTerminal(agent)
      this.writeJournal({ type: "agent-done", id, status: "completed", replayed: true, result: truncate(JSON.stringify(hit.result ?? null), 100_000), at: Date.now() })
      return hit.result
    }

    // resuming: an earlier attempt of this same agent that did not finish but
    // still has a session → continue there instead of starting over
    const prior = this.takeContinuation(phaseTitle, label, agent.prompt)

    await this.acquireSem()
    try {
      if (this.stopRequested) return this.cancel(agent, "run stopped")
      await this.waitIfPaused()
      if (this.stopRequested) return this.cancel(agent, "run stopped")
      if (this.stoppedAgents.has(id)) return this.cancel(agent, "stopped by user")
      // paused before it even started (P on a queued agent)
      if (this.pausedAgents.has(id)) {
        const d = await this.holdForDecision(agent, "paused")
        if (d.kind === "skip") return this.cancel(agent, "stopped by user")
      }
      agent.status = "running"
      agent.startedAt = Date.now()
      this.markDirty()

      // --- session: the agent's own earlier one (resume) or a fresh one -----
      let sessionId: string | undefined
      let followUp: FollowUp | undefined
      if (prior) {
        const note = this.retryNotes[prior.id]
        if (await this.sessionExists(prior.sessionId!)) {
          sessionId = prior.sessionId
          agent.continued = true
          agent.startedAt = prior.startedAt ?? agent.startedAt
          agent.attempts = prior.attempts ?? 0
          agent.toolCalls = prior.toolCalls || 0
          agent.activity = Array.isArray(prior.activity) ? prior.activity : []
          agent.liveFeed = Array.isArray(prior.liveFeed) ? prior.liveFeed : undefined
          agent.tokens = prior.tokens || 0
          agent.outputTokens = prior.outputTokens || 0
          agent.contextTokens = prior.contextTokens || 0
          agent.cost = prior.cost || 0
          this.carried.set(id, { t: agent.tokens, o: agent.outputTokens, c: agent.cost })
          const reason =
            prior.status === "failed" ? prior.error : prior.status === "paused" ? "you were paused by the user" : "the run was interrupted"
          followUp = { reason, note, fresh: false }
          this.logLine("log", `${label}: continuing its earlier session${note ? " with your note" : ""}`)
        } else {
          followUp = note ? { note, fresh: true } : undefined
          this.logLine("log", `${label}: earlier session is gone; starting over${note ? " with your note" : ""}`)
        }
        if (note) agent.retryNote = note
      }
      if (!sessionId) {
        const session = unwrap(await this.deps.client.session.create({
          body: { parentID: this.deps.mainSessionID, title: `wf/${this.state.name}/${label}` },
        }))
        sessionId = session.id as string
      }
      agent.sessionId = sessionId
      this.sessionToAgent.set(sessionId, id)
      this.deps.onChildSession?.(id, sessionId)

      // --- attempt loop -------------------------------------------------------
      // Every prompt goes to the same session, so a retry (automatic or by the
      // user) never throws away the work the agent already did.
      const maxAuto = opts.schema ? 2 : 1
      let autoAttempts = 0
      for (;;) {
        // a decision that arrived while the agent was between prompts
        const early = this.decisions.get(id)
        if (this.stoppedAgents.has(id) || early?.kind === "skip") {
          this.decisions.delete(id)
          return this.cancel(agent, "stopped by user")
        }
        if (early?.kind === "retry") {
          this.decisions.delete(id)
          followUp = { reason: followUp?.reason, note: early.note ?? followUp?.note, fresh: false }
          if (early.note) agent.retryNote = early.note
        }
        if (this.pausedAgents.has(id)) {
          const d = await this.holdForDecision(agent, "paused")
          if (d.kind === "skip") return this.cancel(agent, "stopped by user")
          followUp = { reason: "you were paused by the user", note: d.note, fresh: false }
          if (d.note) agent.retryNote = d.note
          agent.status = "running"
          this.markDirty()
        }

        agent.attempts = (agent.attempts ?? 0) + 1
        const body: any = {
          parts: [{ type: "text", text: this.subagentPrompt(prompt, phaseTitle, opts, followUp) }],
        }
        if (model) body.model = { providerID: model.providerID, modelID: model.modelID }
        const res = unwrap(await this.deps.client.session.prompt({ path: { id: sessionId }, body }))
        const info = res?.info
        if (!info) throw new Error("empty session response")
        this.recordMessage(info)
        if (info.time?.completed) agent.endedAt = info.time.completed
        this.recount()
        this.markDirty()

        // interrupted on purpose (P / X / R while it was running)?
        if (this.stoppedAgents.has(id)) return this.cancel(agent, "stopped by user")
        if (this.pausedAgents.has(id) || this.decisions.has(id)) continue

        let failure: string | undefined
        if (info.error) {
          failure = typeof info.error === "string" ? info.error : info.error?.message ?? JSON.stringify(info.error)
        } else {
          const text = finalText(res?.parts)
          if (!opts.schema) {
            agent.outcomeText = truncate(text, 4000)
            return this.terminate(agent, "completed", text)
          }
          const ex = extractJson(text)
          if (!ex.ok) {
            failure = `previous response was not valid JSON: ${ex.error}`
            agent.activity.push({ tool: "StructuredOutput", title: "invalid output", preview: ex.error, startedAt: Date.now(), endedAt: Date.now() })
          } else {
            try {
              validateSchema(ex.value, opts.schema)
              agent.outcome = ex.value
              agent.outcomeText = truncate(JSON.stringify(ex.value, null, 2), 4000)
              return this.terminate(agent, "completed", ex.value)
            } catch (e: any) {
              failure = `previous JSON failed schema validation: ${e?.message ?? e}`
            }
          }
        }

        // failed attempt: retry on our own first, then ask the user
        autoAttempts++
        if (autoAttempts < maxAuto) {
          followUp = { reason: failure, fresh: false }
          this.markDirty()
          continue
        }
        agent.status = "failed"
        agent.error = opts.schema && !info.error ? `structured output failed after ${agent.attempts} attempts (${failure})` : failure
        agent.endedAt = Date.now()
        this.writeJournal({ type: "agent-done", id, status: "failed", error: agent.error, at: Date.now() })
        if (!this.holdFailed || this.stopRequested) {
          this.onAgentTerminal(agent)
          return null
        }
        const d = await this.holdForDecision(agent, "failed")
        if (d.kind === "skip") {
          this.onAgentTerminal(agent)
          return null
        }
        followUp = { reason: agent.error, note: d.note, fresh: false }
        if (d.note) agent.retryNote = d.note
        agent.status = "running"
        agent.error = undefined
        agent.endedAt = undefined
        autoAttempts = 0
        this.markDirty()
      }
    } catch (e: any) {
      if (this.stopRequested || e instanceof RunAbortedError) return this.cancel(agent, "run stopped")
      if (this.stoppedAgents.has(id)) return this.cancel(agent, "stopped by user")
      agent.status = "failed"
      agent.error = errText(e)
      agent.endedAt = Date.now()
      this.onAgentTerminal(agent)
      this.writeJournal({ type: "agent-done", id, status: agent.status, error: agent.error, at: Date.now() })
      return null
    } finally {
      this.releaseSem()
      this.stoppedAgents.delete(id)
      this.pausedAgents.delete(id)
      this.decisions.delete(id)
    }
  }

  private terminate(agent: AgentState, status: AgentStatus, value: any): any {
    agent.status = status
    agent.held = false
    agent.error = undefined
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

  /** the agent is over without a result; the script gets null */
  private cancel(agent: AgentState, reason: string): null {
    agent.status = "cancelled"
    agent.held = false
    agent.error = reason
    agent.endedAt = Date.now()
    this.onAgentTerminal(agent)
    this.writeJournal({ type: "agent-done", id: agent.id, status: "cancelled", error: reason, at: Date.now() })
    return null
  }

  /**
   * The script keeps waiting for this agent while the user decides: R retries
   * in the same session (optionally with a note), X skips. The concurrency
   * slot is given back meanwhile so other agents are not starved. A run-level
   * stop resolves as skip.
   */
  private async holdForDecision(agent: AgentState, why: "failed" | "paused"): Promise<Decision> {
    if (why === "paused") {
      agent.status = "paused"
      agent.error = undefined
    }
    agent.held = true
    this.recount()
    this.logLine("log", why === "failed" ? `${agent.label} failed — R retries in its session, X skips` : `${agent.label} paused — P resumes, R retries with a note, X stops`)
    this.releaseSem()
    let d: Decision | undefined
    try {
      while (!(d = this.decisions.get(agent.id)) && !this.stopRequested && !this.stoppedAgents.has(agent.id)) {
        await sleep(300)
      }
      this.decisions.delete(agent.id)
    } finally {
      await this.acquireSem()
    }
    this.pausedAgents.delete(agent.id)
    agent.held = false
    if (!d || this.stopRequested || this.stoppedAgents.has(agent.id)) return { kind: "skip" }
    if (d.kind === "retry") this.logLine("log", `${agent.label}: ${why === "paused" ? "resumed" : "retry"}${d.note ? " with your note" : ""}`)
    return d
  }

  private async sessionExists(sessionId: string): Promise<boolean> {
    const get = this.deps.client.session.get
    if (!get) return true
    try {
      const info = unwrap(await get.call(this.deps.client.session, { path: { id: sessionId } }))
      if (!info || typeof info !== "object" || info.error) return false
      return typeof info.id !== "string" || info.id === sessionId
    } catch {
      return false
    }
  }

  /** pop the next journaled result for this (phase, label, prompt), if resuming */
  private takeReplay(phase: string, label: string, prompt: string): { result: any; agent: AgentState } | undefined {
    if (!this.replay) return undefined
    const list = this.replay.get(replayKey(phase, label, prompt))
    if (!list?.length) return undefined
    return list.shift()
  }

  /** pop the next unfinished-but-resumable agent for this (phase, label, prompt), if resuming */
  private takeContinuation(phase: string, label: string, prompt: string): AgentState | undefined {
    if (!this.continuable) return undefined
    const list = this.continuable.get(replayKey(phase, label, prompt))
    if (!list?.length) return undefined
    return list.shift()
  }

  private onAgentTerminal(agent: AgentState): void {
    agent.held = false
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

  /**
   * First prompt: the task. Follow-up in the same session: what went wrong
   * (and the user's note) plus the output contract again — the task itself is
   * already in the conversation, so the agent continues instead of restarting.
   */
  private subagentPrompt(prompt: string, phase: string, opts: AgentOpts, followUp?: FollowUp): string {
    const parts: string[] = []
    const same = followUp && !followUp.fresh
    parts.push(`You are a sub-agent of a workflow run (workflow "${this.state.name}", phase "${phase}").`)
    if (same) {
      parts.push("This is a follow-up in the same session: your task is the TASK message earlier in this conversation.")
      if (followUp.reason) parts.push(`Your previous attempt did not go through — ${followUp.reason}.`)
      if (followUp.note) parts.push(`Note from the user: ${followUp.note}`)
      parts.push("Continue from where you left off. Everything you already found in this session still counts; do not start over or repeat work.")
    } else {
      parts.push("Your final message text is the machine return value of this task — treat it as data for the orchestrator, not a message to a human.")
      parts.push("- Be concise and factual. No conversational preamble, no summaries of what you did.")
      if (followUp?.note) {
        parts.push("")
        parts.push(`Note from the user: ${followUp.note}`)
      }
    }
    if (opts.schema) {
      parts.push("")
      parts.push("Respond with ONLY a single JSON object that matches this JSON Schema exactly. No markdown fences, no text before or after:")
      parts.push(JSON.stringify(opts.schema))
    } else {
      parts.push("")
      parts.push("Return the raw result text. If the result is code or JSON, a fenced block or bare value is fine.")
    }
    if (!same) {
      parts.push("")
      parts.push("--- TASK ---")
      parts.push(prompt)
    }
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
    try {
      rmSync(p, { force: true })
    } catch {}
    if (typeof ctl.agentId === "string" && ctl.agentId) {
      this.controlAgent(ctl.agentId, String(ctl.action ?? ""), typeof ctl.note === "string" ? ctl.note.trim() || undefined : undefined)
      return
    }
    // accept both shapes: {"stop":true} and {"action":"stop"}
    const wantStop = ctl.stop === true || ctl.action === "stop"
    const wantPause = ctl.pause === true || ctl.action === "pause"
    const wantResume = ctl.resume === true || ctl.action === "resume"
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

  /**
   * One agent, by the user: pause (abort, keep the session), resume, retry
   * (continue in the same session with the last error and an optional note),
   * stop (abort and hand null to the script).
   */
  private controlAgent(id: string, action: string, note?: string): void {
    const a = this.state.agents[id]
    if (!a) {
      this.logLine("log", `no agent ${id} in this run`)
      return
    }
    if (this.stopRequested) return
    const live = a.status === "running" || a.status === "queued"
    const waiting = !!a.held
    switch (action) {
      case "pause":
        if (!live) {
          this.logLine("log", `${a.label} is ${a.status}; nothing to pause`)
          return
        }
        this.pausedAgents.add(id)
        this.abortAgent(a)
        this.logLine("log", `${a.label}: pause requested`)
        break
      case "resume":
      case "retry":
        if (waiting || live) {
          this.decisions.set(id, { kind: "retry", note })
          if (a.status === "running") {
            // steer a running agent: interrupt it, the loop continues with the note
            this.abortAgent(a)
            this.logLine("log", `${a.label}: interrupted, continues${note ? " with your note" : ""}`)
          }
        } else if (a.status === "completed") {
          this.logLine("log", `${a.label} already completed; retry it after the run ends (R on the run)`)
        } else {
          this.logLine("log", `${a.label}: the script already received null for it; retry after the run ends (R resumes the run)`)
        }
        break
      case "stop":
      case "skip":
        if (!live && !waiting) {
          this.logLine("log", `${a.label} is already ${a.status}`)
          return
        }
        this.stoppedAgents.add(id)
        this.decisions.set(id, { kind: "skip" })
        if (a.status === "running") this.abortAgent(a)
        this.logLine("log", `${a.label}: stop requested (the script gets null)`)
        break
      default:
        this.logLine("log", `unknown agent action "${action}"`)
    }
    this.markDirty()
  }

  private abortAgent(a: AgentState): void {
    if (!a.sessionId) return
    this.deps.client.session
      .abort({ path: { id: a.sessionId } })
      .catch(() => {})
  }

  private abortAll(): void {
    for (const a of Object.values(this.state.agents)) {
      if (a.status === "running" && a.sessionId) {
        this.stoppedAgents.add(a.id)
        this.abortAgent(a)
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
        return a && isSettled(a)
      }).length
    }
    const agents = Object.values(this.state.agents)
    this.state.agentCount = agents.length
    this.state.agentDone = agents.filter((a) => isSettled(a)).length
    this.state.totalTokens = agents.reduce((s, a) => s + (a.tokens || 0), 0)
    this.state.totalContextTokens = agents.reduce((s, a) => s + (a.contextTokens || 0), 0)
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
      // a terminal state keeps the heartbeat of its last live moment, so a
      // reader can still tell "finished" from "engine vanished"
      if (this.state.status === "running" || this.state.status === "pending" || this.state.status === "paused") {
        this.state.heartbeatAt = Date.now()
        this.state.enginePid = process.pid
        this.state.engineHost = hostname()
      }
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
      if (a.status === "running" || a.status === "queued" || a.status === "paused") {
        a.status = "cancelled"
        a.error = reason
        a.endedAt = Date.now()
      }
      // a held failure keeps its error; the session stays and continues on resume
      a.held = false
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

/** prompt size of one API call: everything the model read, minus what it wrote */
function contextTokens(t: any): number {
  if (!t) return 0
  return (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
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

function feedLine(text: string): string {
  return String(text ?? "").trim().replace(/\s+/g, " ").slice(0, 160)
}

function fmtSecs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`
}
