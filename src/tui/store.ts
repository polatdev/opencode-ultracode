import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createMemo, createSignal } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { controlPath, workflowRoot, type RunState } from "../shared/state.ts"

export interface WorkflowStore {
  runs: () => RunState[]
  activeRun: () => RunState | undefined
  openRun: (runId: string) => void
  closeRun: () => void
  activeRunId: () => string | undefined

  selPhase: () => number
  setSelPhase: (i: number) => void
  selAgent: () => string | undefined
  setSelAgent: (id: string | undefined) => void
  expandActivity: () => boolean
  toggleExpand: () => void
  resetSelection: () => void

  runsDir: () => string
  control: (runId: string, action: "pause" | "resume" | "stop") => void
  deleteRun: (runId: string) => void
  saveScript: (run: RunState) => string | undefined
  markNotified: (runId: string) => void
  wasNotified: (runId: string) => boolean
}

export function createStore(api: TuiPluginApi, onDispose?: (fn: () => void) => void): WorkflowStore {
  const root = () => api.state.path.worktree || api.state.path.directory
  const wfRoot = () => workflowRoot(root())
  const runsDir = () => join(wfRoot(), "runs")

  const [version, setVersion] = createSignal(0)
  const cache = new Map<string, { mtime: number; state: RunState }>()
  let listRef: RunState[] = []
  let lastSig = ""
  let activeId: string | undefined

  const [selPhase, setSelPhase] = createSignal(0)
  const [selAgent, setSelAgent] = createSignal("")
  const [expand, setExpand] = createSignal(false)
  const notified = new Set<string>()

  function refresh(): void {
    let names: string[] = []
    try {
      names = readdirSync(runsDir()).filter((n) => n.startsWith("run_"))
    } catch {
      names = []
    }
    names.sort()
    const sigs: string[] = []
    const list: RunState[] = []
    for (const n of names) {
      const p = join(runsDir(), n, "state.json")
      try {
        const st = statSync(p)
        sigs.push(`${n}:${st.mtimeMs}`)
        const hit = cache.get(n)
        if (hit && hit.mtime === st.mtimeMs) {
          list.push(hit.state)
        } else {
          const state = JSON.parse(readFileSync(p, "utf8")) as RunState
          cache.set(n, { mtime: st.mtimeMs, state })
          list.push(state)
        }
      } catch {}
    }
    // only bump when something actually changed — an unconditional bump on
    // every 500ms tick re-renders the whole tree and makes columns jitter
    const sig = sigs.join(",")
    if (sig === lastSig) return
    lastSig = sig
    const seen = new Set(names)
    for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k)
    list.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    listRef = list
    setVersion((v) => v + 1)
  }

  // version() read makes these memos re-evaluate on every refresh/selection
  // change — listRef/activeId are closure vars Solid cannot track on its own.
  const runs = createMemo(() => {
    version()
    return listRef
  })
  const activeRun = createMemo(() => {
    version()
    return activeId ? (cache.get(activeId)?.state ?? listRef.find((r) => r.runId === activeId)) : undefined
  })

  const dispose = onDispose ?? (() => {})
  const timer = setInterval(() => {
    try {
      refresh()
    } catch {}
  }, 500)
  dispose(() => clearInterval(timer))
  refresh()

  return {
    runs,
    activeRun,
    openRun: (runId) => {
      activeId = runId
      setSelPhase(0)
      setSelAgent("")
      setExpand(false)
      setVersion((v) => v + 1)
    },
    closeRun: () => {
      activeId = undefined
      setVersion((v) => v + 1)
    },
    activeRunId: () => activeId,
    selPhase,
    setSelPhase,
    selAgent: () => selAgent() || undefined,
    setSelAgent: (id) => setSelAgent(id ?? ""),
    expandActivity: () => expand(),
    toggleExpand: () => {
      setExpand((v) => !v)
      setVersion((v) => v + 1)
    },
    resetSelection: () => {
      setSelPhase(0)
      setSelAgent("")
      setExpand(false)
    },
    runsDir,
    control: (runId, action) => {
      try {
        mkdirSync(join(runsDir(), runId), { recursive: true })
        writeFileSync(controlPath(wfRoot(), runId), JSON.stringify({ action, at: Date.now() }))
      } catch {}
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
        const destDir = join(root(), ".opencode", "workflows")
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
