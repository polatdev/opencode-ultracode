// TUI store: polls /tmp/opencode-workflows/<project>/<id>/state.json and exposes the
// run list as a fine-grained Solid store. Changed files are merged with
// `reconcile`, so only the cells whose values actually changed re-render —
// rows are never torn down and rebuilt on a tick, which keeps the view calm.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { batch, createMemo, createSignal } from "solid-js"
import { createStore as createSolidStore, reconcile } from "solid-js/store"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { controlPath, runsRoot, workflowRoot, type RunState } from "../shared/state.ts"

export interface WorkflowStore {
  /** all runs, newest first (fine-grained proxies — read fields inside JSX) */
  runs: () => RunState[]
  runById: (runId: string) => RunState | undefined
  activeRun: () => RunState | undefined
  activeRunId: () => string | undefined
  openRun: (runId: string) => void
  closeRun: () => void

  selPhase: () => number
  setSelPhase: (i: number) => void
  selAgent: () => string | undefined
  setSelAgent: (id: string | undefined) => void
  expandActivity: () => boolean
  toggleExpand: () => void
  fullPrompt: () => boolean
  toggleFullPrompt: () => void

  /** wall clock, refreshed every second while something is running */
  now: () => number
  /** animated spinner frame for running items */
  spinner: () => string
  /** terminal size, refreshed on resize */
  size: () => { width: number; height: number }
  /** true when a run claims to be live but its state file stopped updating */
  isStale: (run: RunState) => boolean

  runsDir: () => string
  control: (runId: string, action: "pause" | "resume" | "stop") => void
  /** a control.json the engine has not consumed yet (e.g. resume waiting for the server plugin) */
  pendingControl: (runId: string) => "pause" | "resume" | "stop" | undefined
  deleteRun: (runId: string) => void
  saveScript: (run: RunState) => string | undefined
  markNotified: (runId: string) => void
  wasNotified: (runId: string) => boolean
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const POLL_MS = 250

export function isLive(status: string | undefined): boolean {
  return status === "running" || status === "paused" || status === "pending"
}

/** the engine heartbeats state.json every ~2s; a live run whose file is
 *  this old has lost its engine (opencode crashed or was closed) */
export const STALE_AFTER_MS = 20_000

export function createStore(api: TuiPluginApi, onDispose?: (fn: () => void) => void): WorkflowStore {
  const root = () => api.state.path.worktree || api.state.path.directory
  const runsDir = () => runsRoot(root())
  const dispose = onDispose ?? (() => {})

  const [state, setState] = createSolidStore<{ runs: Record<string, RunState> }>({ runs: {} })
  const [order, setOrder] = createSignal<string[]>([], { equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]) })
  const mtimes = new Map<string, number>()
  const [written, setWritten] = createSignal<Record<string, number>>({})

  const [activeId, setActiveId] = createSignal<string | undefined>(undefined)
  const [selPhase, setSelPhase] = createSignal(0)
  const [selAgent, setSelAgent] = createSignal("")
  const [expand, setExpand] = createSignal(false)
  const [fullPrompt, setFullPrompt] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [frame, setFrame] = createSignal(0)
  const [size, setSize] = createSignal({ width: api.renderer?.terminalWidth ?? 120, height: api.renderer?.terminalHeight ?? 40 })
  const notified = new Set<string>()

  function requestRender(): void {
    try {
      api.renderer?.requestRender?.()
    } catch {}
  }

  // --- polling -------------------------------------------------------------

  function refresh(): void {
    let names: string[] = []
    try {
      names = readdirSync(runsDir()).filter((n) => n.startsWith("run_"))
    } catch {
      names = []
    }
    const seen = new Set(names)
    let changed = false
    const parsed: Array<[string, RunState]> = []
    for (const n of names) {
      const p = join(runsDir(), n, "state.json")
      try {
        const st = statSync(p)
        if (mtimes.get(n) === st.mtimeMs) continue
        // the engine writes with writeFileSync (not atomic) — a half-written
        // file fails to parse; keep the previous state and retry next tick
        const json = JSON.parse(readFileSync(p, "utf8")) as RunState
        if (!json || typeof json !== "object" || !json.runId) continue
        mtimes.set(n, st.mtimeMs)
        parsed.push([n, json])
      } catch {}
    }
    const gone = [...mtimes.keys()].filter((k) => !seen.has(k))
    if (!parsed.length && !gone.length) return

    batch(() => {
      for (const [n, json] of parsed) {
        // merge: true → keyless arrays (phases, activity, liveFeed) merge by
        // index instead of being replaced, so their rows keep identity
        setState("runs", n, reconcile(json, { key: "id", merge: true }))
        changed = true
      }
      for (const k of gone) {
        mtimes.delete(k)
        setState("runs", k, undefined as any)
        changed = true
      }
      const ids = Object.keys(state.runs).filter((k) => state.runs[k])
      ids.sort((a, b) => (state.runs[b]?.startedAt ?? 0) - (state.runs[a]?.startedAt ?? 0))
      setOrder(ids)
      setWritten(Object.fromEntries(mtimes))
    })
    if (changed) requestRender()
  }

  const pollTimer = setInterval(() => {
    try {
      refresh()
    } catch {}
  }, POLL_MS)
  dispose(() => clearInterval(pollTimer))
  refresh()

  // --- clock + spinner ------------------------------------------------------
  // The spinner only animates while a run is live; otherwise the screen is
  // fully static and no frames are drawn.

  const anyLive = createMemo(() => order().some((id) => isLive(state.runs[id]?.status)))
  const clock = setInterval(() => {
    setNow(Date.now())
    if (anyLive()) requestRender()
  }, 1000)
  dispose(() => clearInterval(clock))

  let spinTimer: ReturnType<typeof setInterval> | null = null
  const spinTick = () => {
    if (!anyLive()) return
    setFrame((f) => (f + 1) % SPINNER.length)
    requestRender()
  }
  spinTimer = setInterval(spinTick, 120)
  dispose(() => spinTimer && clearInterval(spinTimer))

  // --- resize ---------------------------------------------------------------

  const onResize = () => {
    try {
      setSize({ width: api.renderer.terminalWidth, height: api.renderer.terminalHeight })
    } catch {}
  }
  try {
    api.renderer?.on?.("resize", onResize)
    dispose(() => {
      try {
        api.renderer?.off?.("resize", onResize)
      } catch {}
    })
  } catch {}

  // --- derived --------------------------------------------------------------

  const runs = createMemo(() => order().map((id) => state.runs[id]).filter(Boolean) as RunState[])
  const activeRun = createMemo(() => {
    const id = activeId()
    return id ? state.runs[id] : undefined
  })

  return {
    runs,
    runById: (id) => state.runs[id],
    activeRun,
    activeRunId: activeId,
    openRun: (runId) => {
      batch(() => {
        setActiveId(runId)
        setSelPhase(0)
        setSelAgent("")
        setExpand(false)
        setFullPrompt(false)
      })
    },
    closeRun: () => setActiveId(undefined),

    selPhase,
    setSelPhase: (i) => setSelPhase(i),
    selAgent: () => selAgent() || undefined,
    setSelAgent: (id) => setSelAgent(id ?? ""),
    expandActivity: expand,
    toggleExpand: () => setExpand((v) => !v),
    fullPrompt,
    toggleFullPrompt: () => setFullPrompt((v) => !v),

    now,
    spinner: () => SPINNER[frame()] ?? SPINNER[0],
    size,
    isStale: (run) => {
      if (!isLive(run.status)) return false
      const at = written()[run.runId]
      return at != null && now() - at > STALE_AFTER_MS
    },

    runsDir,
    control: (runId, action) => {
      try {
        mkdirSync(join(runsDir(), runId), { recursive: true })
        writeFileSync(controlPath(runsDir(), runId), JSON.stringify({ action, at: Date.now() }))
      } catch {}
    },
    pendingControl: (runId) => {
      now() // re-evaluate each clock tick
      try {
        const raw = readFileSync(controlPath(runsDir(), runId), "utf8")
        const a = JSON.parse(raw)?.action
        return a === "pause" || a === "resume" || a === "stop" ? a : undefined
      } catch {
        return undefined
      }
    },
    deleteRun: (runId) => {
      try {
        rmSync(join(runsDir(), runId), { recursive: true, force: true })
        refresh()
      } catch {}
    },
    saveScript: (run) => {
      try {
        const src = join(runsDir(), run.runId, "script.js")
        if (!existsSync(src)) return undefined
        const destDir = workflowRoot(root())
        mkdirSync(destDir, { recursive: true })
        const dest = join(destDir, `${safe(run.name)}.js`)
        writeFileSync(dest, readFileSync(src, "utf8"))
        return dest
      } catch {
        return undefined
      }
    },
    markNotified: (id) => {
      notified.add(id)
    },
    wasNotified: (id) => notified.has(id),
  }
}

function safe(n: string): string {
  return n.replace(/[^a-zA-Z0-9_-]/g, "-")
}
