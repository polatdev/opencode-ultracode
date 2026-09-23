// Pending permission / question requests, tracked in the TUI process.
//
// opencode's own permission dialog lives in the `session` route; while one of
// our workflow routes is on screen nothing surfaces a sub-agent that is blocked
// on "may I read this folder?" — the agent just sits there as "running". This
// module follows the server's pending requests (initial list + live events,
// re-listed periodically as a safety net) so the views can flag the agent and
// let the user answer from inside /workflows.

import { batch, createMemo, createSignal } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { isSettled, type AgentState, type RunState } from "../shared/state.ts"

export type PendingRequest =
  | { kind: "permission"; id: string; sessionID: string; at: number; req: PermissionRequest }
  | { kind: "question"; id: string; sessionID: string; at: number; req: QuestionRequest }

export type PermissionReply = "once" | "always" | "reject"

export interface RequestStore {
  /** every pending request the server knows about, oldest first */
  all: () => PendingRequest[]
  forSession: (sessionID: string | undefined) => PendingRequest[]
  forAgent: (agent: AgentState | undefined) => PendingRequest[]
  /** agents of this run that are blocked on a request, in spawn order */
  waitingAgents: (run: RunState) => AgentState[]
  /** requests that belong to no workflow agent (e.g. the main session) */
  unattributed: (runs: RunState[]) => PendingRequest[]

  replyPermission: (id: string, reply: PermissionReply) => Promise<boolean>
  replyQuestion: (id: string, answers: string[][]) => Promise<boolean>
  rejectQuestion: (id: string) => Promise<boolean>

  /** register a callback for requests that appear after startup */
  onNew: (fn: (p: PendingRequest) => void) => void
}

const RELIST_MS = 5000

export function createRequestStore(api: TuiPluginApi, onDispose: (fn: () => void) => void): RequestStore {
  const [pending, setPending] = createSignal<Record<string, PendingRequest>>({})
  const listeners: Array<(p: PendingRequest) => void> = []
  // ids we answered but the server has not yet confirmed gone — hidden from
  // the views so a double keypress cannot answer twice
  const answered = new Set<string>()
  let seeded = false

  function requestRender(): void {
    try {
      api.renderer?.requestRender?.()
    } catch {}
  }

  const add = (p: PendingRequest, announce: boolean) => {
    if (answered.has(p.id)) return
    let isNew = false
    setPending((cur) => {
      if (cur[p.id]) return cur
      isNew = true
      return { ...cur, [p.id]: p }
    })
    if (isNew) {
      requestRender()
      if (announce) for (const fn of listeners) fn(p)
    }
  }
  const remove = (id: string) => {
    answered.delete(id)
    setPending((cur) => {
      if (!cur[id]) return cur
      const next = { ...cur }
      delete next[id]
      return next
    })
    requestRender()
  }

  const wrapPermission = (req: PermissionRequest, at: number): PendingRequest => ({ kind: "permission", id: req.id, sessionID: req.sessionID, at, req })
  const wrapQuestion = (req: QuestionRequest, at: number): PendingRequest => ({ kind: "question", id: req.id, sessionID: req.sessionID, at, req })

  // --- full re-list: startup seed + periodic safety net -------------------------

  async function relist(): Promise<void> {
    let perms: PermissionRequest[] = []
    let questions: QuestionRequest[] = []
    let ok = false
    try {
      const [p, q] = await Promise.all([api.client.permission.list(), api.client.question.list()])
      perms = ((p as any)?.data ?? []) as PermissionRequest[]
      questions = ((q as any)?.data ?? []) as QuestionRequest[]
      ok = !(p as any)?.error && !(q as any)?.error
    } catch {
      return
    }
    if (!ok) return
    const now = Date.now()
    const live = new Set<string>()
    batch(() => {
      for (const r of perms) {
        live.add(r.id)
        add(wrapPermission(r, pending()[r.id]?.at ?? now), seeded)
      }
      for (const r of questions) {
        live.add(r.id)
        add(wrapQuestion(r, pending()[r.id]?.at ?? now), seeded)
      }
      // anything the server no longer lists was answered elsewhere (main session dialog, another client)
      for (const id of Object.keys(pending())) if (!live.has(id)) remove(id)
    })
    seeded = true
  }

  relist().catch(() => {})
  const timer = setInterval(() => {
    relist().catch(() => {})
  }, RELIST_MS)
  onDispose(() => clearInterval(timer))

  // --- live events ------------------------------------------------------------------

  const subs: Array<() => void> = []
  try {
    subs.push(api.event.on("permission.asked", (e) => add(wrapPermission(e.properties, Date.now()), true)))
    subs.push(api.event.on("permission.replied", (e) => remove(e.properties.requestID)))
    subs.push(api.event.on("question.asked", (e) => add(wrapQuestion(e.properties, Date.now()), true)))
    subs.push(api.event.on("question.replied", (e) => remove(e.properties.requestID)))
    subs.push(api.event.on("question.rejected", (e) => remove(e.properties.requestID)))
  } catch {}
  onDispose(() => {
    for (const off of subs) {
      try {
        off()
      } catch {}
    }
  })

  // --- derived --------------------------------------------------------------------------

  const all = createMemo(() => Object.values(pending()).sort((a, b) => a.at - b.at))
  const bySession = createMemo(() => {
    const m = new Map<string, PendingRequest[]>()
    for (const p of all()) {
      const list = m.get(p.sessionID)
      if (list) list.push(p)
      else m.set(p.sessionID, [p])
    }
    return m
  })

  const forSession = (sessionID: string | undefined): PendingRequest[] => (sessionID ? bySession().get(sessionID) ?? [] : [])
  /**
   * An agent blocks on a permission prompt whenever its session is still open —
   * which includes queued, paused and held agents, not just "running" ones.
   * Filtering on status === "running" hid exactly the deadlock the operator
   * opened /workflows to find. Settled agents (terminal and not held) are
   * excluded: their sessions were aborted, so any request there is stale.
   */
  const blocksOnRequests = (a: AgentState | undefined): a is AgentState => !!a && !!a.sessionId && !isSettled(a)
  const forAgent = (agent: AgentState | undefined): PendingRequest[] => {
    if (!blocksOnRequests(agent)) return []
    return forSession(agent.sessionId)
  }

  // --- replies ---------------------------------------------------------------------------

  const markAnswered = (id: string) => {
    answered.add(id)
    setPending((cur) => {
      if (!cur[id]) return cur
      const next = { ...cur }
      delete next[id]
      return next
    })
    requestRender()
  }
  const unmark = (id: string, p: PendingRequest | undefined) => {
    answered.delete(id)
    if (p) add(p, false)
  }

  return {
    all,
    forSession,
    forAgent,
    waitingAgents: (run) => {
      const sessions = bySession()
      if (!sessions.size) return []
      const out: AgentState[] = []
      for (const id of run.agentOrder) {
        const a = run.agents[id]
        if (blocksOnRequests(a) && sessions.has(a.sessionId!)) out.push(a)
      }
      return out
    },
    unattributed: (runs) => {
      const owned = new Set<string>()
      for (const r of runs) for (const id of r.agentOrder) {
        const s = r.agents[id]?.sessionId
        if (s) owned.add(s)
      }
      return all().filter((p) => !owned.has(p.sessionID))
    },

    replyPermission: async (id, reply) => {
      const prev = pending()[id]
      markAnswered(id)
      try {
        const res: any = await api.client.permission.reply({ requestID: id, reply })
        if (res?.error) throw new Error(errText(res.error))
        return true
      } catch (e) {
        unmark(id, prev)
        api.ui.toast({ variant: "error", message: `Could not send reply: ${errText(e)}` })
        return false
      }
    },
    replyQuestion: async (id, answers) => {
      const prev = pending()[id]
      markAnswered(id)
      try {
        const res: any = await api.client.question.reply({ requestID: id, answers })
        if (res?.error) throw new Error(errText(res.error))
        return true
      } catch (e) {
        unmark(id, prev)
        api.ui.toast({ variant: "error", message: `Could not send answer: ${errText(e)}` })
        return false
      }
    },
    rejectQuestion: async (id) => {
      const prev = pending()[id]
      markAnswered(id)
      try {
        const res: any = await api.client.question.reject({ requestID: id })
        if (res?.error) throw new Error(errText(res.error))
        return true
      } catch (e) {
        unmark(id, prev)
        api.ui.toast({ variant: "error", message: `Could not reject: ${errText(e)}` })
        return false
      }
    },

    onNew: (fn) => {
      listeners.push(fn)
    },
  }
}

/** one-line description of what the request is asking for */
export function describeRequest(p: PendingRequest): string {
  if (p.kind === "permission") {
    const pats = p.req.patterns?.filter(Boolean) ?? []
    return pats.length ? `${p.req.permission}: ${pats.join(", ")}` : p.req.permission
  }
  const q = p.req.questions?.[0]
  const more = (p.req.questions?.length ?? 0) - 1
  return q ? `${q.header || "question"}: ${q.question}${more > 0 ? ` (+${more} more)` : ""}` : "question"
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  const any = e as any
  if (any?.data?.message) return String(any.data.message)
  if (any?.message) return String(any.message)
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}
