/** @jsxImportSource @opentui/solid */
// opencode-workflow — TUI plugin: /workflows command + progress routes.
//
// Routes:
//   workflows       — list of runs
//   workflow        — two-pane progress view (phases | agents)
//   workflow-agent  — agent detail (prompt / activity / outcome)
//
// State comes from .opencode/workflows/runs/<id>/state.json, polled by the store.

import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { clip, fmtDuration, fmtElapsed, fmtTokens, shortModel } from "../shared/format.ts"
import type { AgentState, RunState } from "../shared/state.ts"
import { createStore, type WorkflowStore } from "./store.ts"

const LIST_COLS = { name: 26, status: 11, agents: 9, tokens: 11, elapsed: 9, time: 9 } as const
const AGENT_COLS = { icon: 3, label: 19, model: 14, tokens: 11, tools: 9, elapsed: 8 } as const

export const plugin: TuiPluginModule = {
  id: "opencode-workflow",
  tui: async (api) => {
    const store = createStore(api, (fn) => api.lifecycle.onDispose(fn))

    // selection state shared across views
    const [listSel, setListSel] = createSignal(0)
    const [pane, setPane] = createSignal<"phases" | "agents">("phases")
    const [agentOpenId, setAgentOpenId] = createSignal("")
    let origin: { name: string; params?: Record<string, unknown> } = { name: "home" }

    const runs = () => store.runs()

    // --- navigation -----------------------------------------------------------

    const openWorkflows = () => {
      const cur = api.route.current
      if (cur.name !== "workflow" && cur.name !== "workflow-agent") origin = cur as any
      api.route.navigate("workflows")
    }

    const goBack = () => {
      if (agentOpenId()) {
        setAgentOpenId("")
        api.route.navigate("workflow")
        return
      }
      if (store.activeRunId()) {
        store.closeRun()
        api.route.navigate("workflows")
        return
      }
      api.route.navigate(origin.name, origin.params ?? {})
    }

    const selectedRun = (): RunState | undefined => runs()[listSel()]
    const activeRun = (): RunState | undefined => store.activeRun()

    const movePhase = (dir: number) => {
      const r = activeRun()
      if (!r || !r.phases.length) return
      const next = Math.max(0, Math.min(r.phases.length - 1, store.selPhase() + dir))
      if (next !== store.selPhase()) store.setSelPhase(next)
    }

    const moveAgentInPhase = (dir: number) => {
      const r = activeRun()
      if (!r) return
      const p = r.phases[store.selPhase()]
      const ids = p?.agentIds ?? []
      if (!ids.length) return
      const curSel = store.selAgent()
      const cur = curSel ? ids.indexOf(curSel) : -1
      const next = Math.max(0, Math.min(ids.length - 1, (cur < 0 ? 0 : cur) + dir))
      store.setSelAgent(ids[next] ?? "")
    }

    const focusAgents = () => {
      if (!activeRun()) return
      store.setSelAgent("")
      moveAgentInPhase(0)
      setPane("agents")
    }

    // --- actions ----------------------------------------------------------------

    const doStop = (run: RunState) => {
      if (run.status === "running" || run.status === "paused") {
        store.control(run.runId, "stop")
        api.ui.toast({ variant: "warning", message: `Stopping workflow ${run.name}…` })
      }
    }
    const doPause = (run: RunState) => {
      if (run.status === "running") {
        store.control(run.runId, "pause")
        api.ui.toast({ variant: "info", message: `Pausing workflow ${run.name}…` })
      } else if (run.status === "paused") {
        store.control(run.runId, "resume")
        api.ui.toast({ variant: "info", message: `Resuming workflow ${run.name}…` })
      }
    }
    const doSave = (run: RunState) => {
      const dest = store.saveScript(run)
      api.ui.toast(
        dest
          ? { variant: "success", message: `Saved as workflow: ${dest}` }
          : { variant: "error", message: "No saved script for this run" },
      )
    }

    // --- keymap -------------------------------------------------------------------

    api.keymap.registerLayer({
      commands: [
        {
          name: "workflows.open",
          title: "Workflows",
          category: "Plugin",
          namespace: "palette",
          slashName: "workflows",
          desc: "Open workflow runs",
          run: () => openWorkflows(),
        },
        { name: "wf.list.up", run: () => setListSel((v) => Math.max(0, v - 1)) },
        { name: "wf.list.down", run: () => setListSel((v) => Math.min(Math.max(0, runs().length - 1), v + 1)) },
        {
          name: "wf.list.open",
          run: () => {
            const r = selectedRun()
            if (!r) return
            store.openRun(r.runId)
            setPane("phases")
            store.setSelAgent("")
            setAgentOpenId("")
            api.route.navigate("workflow")
          },
        },
        { name: "wf.list.stop", run: () => selectedRun() && doStop(selectedRun()!) },
        { name: "wf.list.pause", run: () => selectedRun() && doPause(selectedRun()!) },
        { name: "wf.list.save", run: () => selectedRun() && doSave(selectedRun()!) },
        {
          name: "wf.list.delete",
          run: () => {
            const r = selectedRun()
            if (!r) return
            if (r.status === "running" || r.status === "paused") {
              api.ui.toast({ variant: "error", message: "Run is active — stop it first (x), then delete (d)" })
              return
            }
            store.deleteRun(r.runId)
            setListSel((v) => Math.min(v, Math.max(0, runs().length - 1)))
            api.ui.toast({ variant: "success", message: `Deleted run: ${r.name}` })
          },
        },
        { name: "wf.list.back", run: () => goBack() },

        { name: "wf.run.up", run: () => (pane() === "phases" ? movePhase(-1) : moveAgentInPhase(-1)) },
        { name: "wf.run.down", run: () => (pane() === "phases" ? movePhase(1) : moveAgentInPhase(1)) },
        { name: "wf.run.left", run: () => setPane("phases") },
        { name: "wf.run.right", run: () => focusAgents() },
        {
          name: "wf.run.open",
          run: () => {
            if (pane() === "phases") {
              focusAgents()
              return
            }
            const r = activeRun()
            const aid = store.selAgent()
            if (!r || !aid) return
            setAgentOpenId(aid)
            api.route.navigate("workflow-agent")
          },
        },
        { name: "wf.run.stop", run: () => activeRun() && doStop(activeRun()!) },
        { name: "wf.run.pause", run: () => activeRun() && doPause(activeRun()!) },
        { name: "wf.run.save", run: () => activeRun() && doSave(activeRun()!) },
        { name: "wf.run.back", run: () => goBack() },

        {
          name: "wf.agent.up",
          run: () => moveAgent(-1),
        },
        {
          name: "wf.agent.down",
          run: () => moveAgent(1),
        },
        { name: "wf.agent.expand", run: () => store.toggleExpand() },
        { name: "wf.agent.back", run: () => goBack() },
      ],
      bindings: [{ key: "ctrl+shift+w", cmd: "workflows.open", desc: "Open workflows" }],
    })

    api.keymap.registerLayer({
      mode: "wf.list",
      bindings: [
        { key: "up", cmd: "wf.list.up" },
        { key: "down", cmd: "wf.list.down" },
        { key: "k", cmd: "wf.list.up" },
        { key: "j", cmd: "wf.list.down" },
        { key: "enter", cmd: "wf.list.open" },
        { key: "x", cmd: "wf.list.stop" },
        { key: "p", cmd: "wf.list.pause" },
        { key: "s", cmd: "wf.list.save" },
        { key: "d", cmd: "wf.list.delete" },
        { key: "escape", cmd: "wf.list.back" },
      ],
    })
    api.keymap.registerLayer({
      mode: "wf.run",
      bindings: [
        { key: "up", cmd: "wf.run.up" },
        { key: "down", cmd: "wf.run.down" },
        { key: "k", cmd: "wf.run.up" },
        { key: "j", cmd: "wf.run.down" },
        { key: "left", cmd: "wf.run.left" },
        { key: "right", cmd: "wf.run.right" },
        { key: "h", cmd: "wf.run.left" },
        { key: "l", cmd: "wf.run.right" },
        { key: "enter", cmd: "wf.run.open" },
        { key: "x", cmd: "wf.run.stop" },
        { key: "p", cmd: "wf.run.pause" },
        { key: "s", cmd: "wf.run.save" },
        { key: "escape", cmd: "wf.run.back" },
      ],
    })
    api.keymap.registerLayer({
      mode: "wf.agent",
      bindings: [
        { key: "up", cmd: "wf.agent.up" },
        { key: "down", cmd: "wf.agent.down" },
        { key: "left", cmd: "wf.agent.expand" },
        { key: "escape", cmd: "wf.agent.back" },
      ],
    })

    function moveAgent(dir: number) {
      const r = activeRun()
      if (!r) return
      const agents = r.agentOrder.filter((id) => r.agents[id] && r.agents[id].phase === storePhaseTitle(r))
      const all = agents.length ? agents : r.agentOrder
      const cur = all.indexOf(agentOpenId())
      const next = Math.max(0, Math.min(all.length - 1, (cur < 0 ? 0 : cur) + dir))
      setAgentOpenId(all[next] ?? all[0] ?? "")
    }

    function storePhaseTitle(r: RunState): string {
      const p = r.phases[store.selPhase()]
      return p?.title ?? ""
    }

    // --- routes ----------------------------------------------------------------

    api.route.register([
      {
        name: "workflows",
        render: () => {
          const pop = api.mode.push("wf.list")
          onCleanup(pop)
          return <ListScreen api={api} store={store} sel={listSel} /> as any
        },
      },
      {
        name: "workflow",
        render: () => {
          const pop = api.mode.push("wf.run")
          onCleanup(pop)
          return <RunScreen api={api} store={store} pane={pane} /> as any
        },
      },
      {
        name: "workflow-agent",
        render: () => {
          const pop = api.mode.push("wf.agent")
          onCleanup(pop)
          return <AgentScreen api={api} store={store} agentId={() => agentOpenId()} /> as any
        },
      },
    ])

    // --- attention on terminal transition ------------------------------------------

    createEffect(() => {
      for (const r of runs()) {
        const terminal = r.status === "completed" || r.status === "failed" || r.status === "stopped"
        if (!terminal || !r.endedAt) continue
        if (Date.now() - r.endedAt > 10 * 60_000) continue // don't notify for old runs
        if (store.wasNotified(r.runId)) continue
        store.markNotified(r.runId)
        const icon = r.status === "completed" ? "completed" : r.status
        try {
          api.attention.notify({
            message: `Workflow ${r.name}: ${icon} (${r.agentDone}/${r.agentCount} agents, ${fmtTokens(r.totalTokens)})`,
            sound: { name: r.status === "failed" ? "error" : "done" },
          })
        } catch {}
      }
    })
  },
}

// =============================================================================
// screens
// =============================================================================

interface ScreenProps {
  api: TuiPluginApi
  store: WorkflowStore
}

function statusIcon(status: string): { ch: string; color: "success" | "error" | "warning" | "info" | "muted" } {
  switch (status) {
    case "completed":
      return { ch: "✓", color: "success" }
    case "failed":
      return { ch: "✗", color: "error" }
    case "stopped":
      return { ch: "■", color: "warning" }
    case "paused":
      return { ch: "❚❚", color: "warning" }
    case "running":
      return { ch: "●", color: "info" }
    default:
      return { ch: "○", color: "muted" }
  }
}

function colorToken(api: TuiPluginApi, which: "success" | "error" | "warning" | "info" | "muted") {
  const t = api.theme.current
  if (which === "success") return t.success
  if (which === "error") return t.error
  if (which === "warning") return t.warning
  if (which === "info") return t.accent
  return t.textMuted
}

function ListScreen(props: ScreenProps & { sel: () => number }) {
  const { api, store } = props
  const t = api.theme.current
  const runs = store.runs
  const active = () => runs().filter((r) => r.status === "running" || r.status === "paused").length
  return (
    <box flexDirection="column" style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
      <box flexDirection="row" style={{ border: true, borderColor: t.border, paddingLeft: 1, paddingRight: 1, paddingTop: 1, paddingBottom: 1 }}>
        <text style={{ fg: t.accent }}>WORKFLOWS</text>
        <text style={{ flexGrow: 1 }} />
        <text style={{ fg: t.textMuted }}>{`${runs().length} runs · ${active()} active`}</text>
      </box>
      <box flexDirection="row" style={{ border: true, borderColor: t.border, paddingLeft: 1, paddingRight: 1, paddingTop: 0, paddingBottom: 0 }}>
        <text style={{ fg: t.textMuted, width: 3 }} />
        <text style={{ fg: t.textMuted, width: LIST_COLS.name }}>NAME</text>
        <text style={{ fg: t.textMuted, width: LIST_COLS.status }}>STATUS</text>
        <text style={{ fg: t.textMuted, width: LIST_COLS.agents }}>AGENTS</text>
        <text style={{ fg: t.textMuted, width: LIST_COLS.tokens }}>TOKENS</text>
        <text style={{ fg: t.textMuted, width: LIST_COLS.elapsed }}>TIME</text>
        <text style={{ fg: t.textMuted, width: 3 }} />
        <text style={{ fg: t.textMuted }}>STARTED</text>
      </box>
      <box flexDirection="column" style={{ flexGrow: 1, overflow: "hidden" }}>
        <Show when={runs().length === 0}>
          <box style={{ paddingTop: 1 }}>
            <text style={{ fg: t.textMuted }}>
              No workflow runs yet. Ask for a workflow ("workflow başlat", "run a workflow") on a large task, or call
              the workflow tool by name.
            </text>
          </box>
        </Show>
        <For each={runs()}>
          {(run, idx) => {
            const isSel = () => idx() === props.sel()
            const st = statusIcon(run.status)
            const dim = () => (isSel() ? t.text : t.textMuted)
            return (
              <box flexDirection="row" style={{ paddingLeft: 1, paddingRight: 1, backgroundColor: isSel() ? t.backgroundElement : undefined }}>
                <text style={{ fg: isSel() ? t.accent : t.textMuted, width: 3 }}>{isSel() ? "▸ " : "  "}</text>
                <text style={{ fg: isSel() ? t.accent : t.text, width: LIST_COLS.name }}>{clip(run.name, LIST_COLS.name - 1).padEnd(LIST_COLS.name)}</text>
                <text style={{ fg: colorToken(api, st.color), width: LIST_COLS.status }}>{`${st.ch} ${String(run.status)}`.padEnd(LIST_COLS.status)}</text>
                <text style={{ fg: dim(), width: LIST_COLS.agents }}>{`${run.agentDone}/${run.agentCount}`.padStart(LIST_COLS.agents)}</text>
                <text style={{ fg: dim(), width: LIST_COLS.tokens }}>{fmtTokens(run.totalTokens).padStart(LIST_COLS.tokens)}</text>
                <text style={{ fg: dim(), width: LIST_COLS.elapsed }}>{fmtDuration(run.endedAt ? run.endedAt - run.startedAt : Date.now() - run.startedAt).padStart(LIST_COLS.elapsed)}</text>
                <text style={{ fg: dim(), width: 3 }} />
                <text style={{ fg: dim() }}>{fmtClock(run.startedAt)}</text>
              </box>
            )
          }}
        </For>
      </box>
      <box style={{ border: true, borderColor: t.border, paddingLeft: 1, paddingRight: 1, paddingTop: 0, paddingBottom: 0 }}>
        <text style={{ fg: t.textMuted }}>
          {"↑↓/jk"} select · {"⏎"} open · x stop · p pause · s save · d delete · esc back
        </text>
      </box>
    </box>
  )
}

function RunScreen(props: ScreenProps & { pane: () => "phases" | "agents" }) {
  const { api, store } = props
  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <Show when={store.activeRun()} fallback={<NoRunHint api={api} />}>
        <RunScreenInner api={api} store={store} pane={props.pane} />
      </Show>
    </box>
  )
}

function NoRunHint(props: { api: TuiPluginApi }) {
  return (
    <box style={{ paddingLeft: 1, paddingTop: 1 }}>
      <text style={{ fg: props.api.theme.current.textMuted }}>no run selected — press esc to go back</text>
    </box>
  )
}

function RunScreenInner(props: { api: TuiPluginApi; store: WorkflowStore; pane: () => "phases" | "agents" }) {
  const { api, store } = props
  const run = store.activeRun()
  if (!run) return <NoRunHint api={api} />
  const t = api.theme.current
  const now = Date.now()
  const phase = run.phases[store.selPhase()] ?? run.phases[0]
  const elapsed = run.endedAt ? run.endedAt - run.startedAt : now - run.startedAt
  const stale = run.status === "running" || run.status === "paused"

  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      {/* header */}
      <box flexDirection="row" style={{ paddingLeft: 1, paddingTop: 1 }}>
        <text style={{ fg: t.accent, width: 34 }}>{clip(run.name, 33)}</text>
        <text style={{ flexGrow: 1 }} />
        <text style={{ fg: t.text }}>
          {`${run.agentDone}/${run.agentCount} agents · ${fmtDuration(elapsed)}`}
        </text>
      </box>
      <box style={{ paddingLeft: 1 }}>
        <text style={{ fg: t.textMuted }}>{clip(run.description, 120)}</text>
      </box>
      <Show when={stale}>
        <box style={{ paddingLeft: 1 }}>
          <text style={{ fg: t.warning }}>{run.status === "paused" ? "paused — press p to resume" : "running in background"}</text>
        </box>
      </Show>

      {/* body: two panes */}
      <box flexDirection="row" style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1, gap: 1 }}>
        {/* left: phases */}
        <box flexDirection="column" style={{ width: 30, border: true, borderColor: props.pane() === "phases" ? t.borderActive : t.border, overflow: "hidden" }}>
          <box style={{ paddingLeft: 1, paddingTop: 1 }}>
            <text style={{ fg: t.textMuted }}>Phases</text>
          </box>
          <For each={run.phases}>
            {(p, i) => {
              const isSel = () => store.selPhase() === i()
              const isDone = p.done === p.agentIds.length && p.agentIds.length > 0
              return (
                <box flexDirection="row" style={{ paddingLeft: 1, backgroundColor: isSel() ? t.backgroundElement : undefined }}>
                  <text style={{ fg: isDone ? t.success : isSel() ? t.accent : t.textMuted, width: 4 }}>
                    {`${isSel() ? "›" : isDone ? "✓" : " "}${String(p.index).padStart(2)} `}
                  </text>
                  <text style={{ fg: isSel() ? t.accent : t.text, width: 17 }}>{clip(p.title, 16)}</text>
                  <text style={{ fg: isDone ? t.success : t.textMuted }}>{`${p.done}/${p.agentIds.length}`}</text>
                </box>
              )
            }}
          </For>
        </box>

        {/* right: agents of selected phase */}
        <box flexDirection="column" style={{ flexGrow: 1, border: true, borderColor: props.pane() === "agents" ? t.borderActive : t.border, overflow: "hidden" }}>
          <box style={{ paddingLeft: 1, paddingTop: 1 }}>
            <text style={{ fg: t.text }}>
              {`${phase?.title ?? ""} · ${phase?.agentIds.length ?? 0} agents`}
            </text>
          </box>
          <Show when={!phase || phase.agentIds.length === 0}>
            <box style={{ paddingLeft: 1 }}>
              <text style={{ fg: t.textMuted }}>
                {run.status === "completed" ? "no agents in this phase" : "Not started yet"}
              </text>
            </box>
          </Show>
          <For each={phase?.agentIds ?? []}>
            {(aid) => {
              const a = run.agents[aid]
              if (!a) return null
              const isSel = () => store.selAgent() === aid
              const st = statusIcon(a.status)
              const dim = () => (isSel() ? t.text : t.textMuted)
              const dur = fmtElapsed(a.startedAt, a.endedAt, now)
              return (
                <box flexDirection="row" style={{ paddingLeft: 1, paddingRight: 1, backgroundColor: isSel() ? t.backgroundElement : undefined }}>
                  <text style={{ fg: colorToken(api, st.color), width: AGENT_COLS.icon }}>{st.ch.padEnd(2) + " "}</text>
                  <text style={{ fg: isSel() ? t.accent : t.text, width: AGENT_COLS.label }}>{clip(a.label, AGENT_COLS.label - 1).padEnd(AGENT_COLS.label)}</text>
                  <text style={{ fg: dim(), width: AGENT_COLS.model }}>{clip(shortModel(a.model), AGENT_COLS.model - 1).padEnd(AGENT_COLS.model)}</text>
                  <text style={{ fg: dim(), width: AGENT_COLS.tokens }}>{fmtTokens(a.tokens).padStart(AGENT_COLS.tokens)}</text>
                  <text style={{ fg: dim(), width: AGENT_COLS.tools }}>{`${a.toolCalls} tools`.padStart(AGENT_COLS.tools)}</text>
                  <text style={{ fg: dim() }}>{dur}</text>
                </box>
              )
            }}
          </For>
        </box>
      </box>

      {/* footer */}
      <box style={{ paddingLeft: 1, paddingBottom: 1 }}>
        <text style={{ fg: t.textMuted }}>
          {`↑↓/jk select · ←→/h l panes · ⏎ ${props.pane() === "phases" ? "agents" : "open agent"} · x stop · p ${run.status === "paused" ? "resume" : "pause"} · s save · esc back`}
        </text>
      </box>
    </box>
  )
}

function AgentScreen(props: ScreenProps & { agentId: () => string }) {
  const { api, store } = props
  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <Show when={store.activeRun()}>
        <AgentScreenInner api={api} store={store} agentId={props.agentId} />
      </Show>
    </box>
  )
}

function AgentScreenInner(props: { api: TuiPluginApi; store: WorkflowStore; agentId: () => string }) {
  const { api, store } = props
  const run = store.activeRun()
  const a: AgentState | undefined = run?.agents[props.agentId()]
  if (!run || !a) {
    return (
      <box flexDirection="column" style={{ flexGrow: 1, paddingLeft: 1, paddingTop: 1 }}>
        <text style={{ fg: api.theme.current.textMuted }}>agent not found — press esc to go back</text>
      </box>
    )
  }
  const t = api.theme.current
  const st = statusIcon(a.status)
  const running = a.status === "running" || a.status === "queued"
  const dur = () => fmtElapsed(a.startedAt, a.endedAt, Date.now())
  const expanded = () => store.expandActivity()
  const outcome = a.outcomeText ?? (typeof a.outcome === "string" ? a.outcome : a.outcome ? JSON.stringify(a.outcome, null, 2) : "")
  const kv = (label: string, value: string, fg?: any) => (
    <text style={{ fg: fg ?? t.textMuted }}>{`${label.padEnd(16)}${value}`}</text>
  )
  return (
    <box flexDirection="column" style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
      {/* header */}
      <box flexDirection="row" style={{ paddingBottom: 1 }}>
        <text style={{ fg: colorToken(api, st.color), width: 4 }}>{st.ch + " "}</text>
        <text style={{ fg: t.accent, width: 42 }}>{clip(a.label, 41)}</text>
        <text style={{ flexGrow: 1 }} />
        <text style={{ fg: t.textMuted }}>{`${run.agentDone}/${run.agentCount} agents · ${a.phase ?? ""}`}</text>
      </box>
      {/* body */}
      <box flexDirection="column" style={{ flexGrow: 1, border: true, borderColor: t.border, overflow: "hidden" }}>
        {/* data */}
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          {kv("model", a.model ?? "default", t.text)}
        </box>
        <box style={{ paddingLeft: 1 }}>
          {kv("status", String(a.status), running ? t.accent : t.text)}
        </box>
        <box style={{ paddingLeft: 1 }}>
          {kv("tokens", `${fmtTokens(a.tokens)} · out ${fmtTokens(a.outputTokens)}`, t.text)}
        </box>
        <box style={{ paddingLeft: 1 }}>
          {kv("cost / tools", `${a.cost ? `$${a.cost.toFixed(4)}` : "$0.0000"} · ${a.toolCalls} tool calls`)}
        </box>
        <box style={{ paddingLeft: 1 }}>
          {kv("time", `${dur()}${a.startedAt ? ` · started ${fmtClock(a.startedAt)}` : ""}`)}
        </box>
        <Show when={a.error}>
          <box style={{ paddingLeft: 1, paddingBottom: 1 }}>
            <text style={{ fg: t.error }}>{clip(a.error ?? "", 200)}</text>
          </box>
        </Show>

        {/* live LLM output */}
        <Show when={running || (a.liveText && !outcome)}>
          <box style={{ paddingLeft: 1, paddingTop: 1 }}>
            <text style={{ fg: running ? t.accent : t.textMuted }}>{running ? "Live output ●" : "Last LLM output"}</text>
          </box>
          <box style={{ paddingLeft: 1, paddingBottom: 1 }}>
            <PreText api={api} text={a.liveText ?? (running ? "waiting for first output…" : "—")} maxLines={6} />
          </box>
        </Show>

        {/* prompt */}
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text style={{ fg: t.text }}>Prompt</text>
        </box>
        <box style={{ paddingLeft: 1 }}>
          <PromptText api={api} text={a.prompt} maxLines={6} />
        </box>

        {/* activity */}
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text style={{ fg: t.text }}>
            {a.activity.length ? `Activity · ${expanded() ? "collapse with ←" : "expand with ←"} (${a.activity.length})` : "Activity (none)"}
          </text>
        </box>
        <For each={a.activity}>
          {(act) => (
            <box flexDirection="column" style={{ paddingLeft: 1 }}>
              <box flexDirection="row">
                <text style={{ fg: colorToken(api, act.endedAt ? "muted" : "info"), width: 3 }}>
                  {act.endedAt ? "✓" : "●"}
                </text>
                <text style={{ fg: t.text }}>{`${act.tool}(${clip(act.title, 90)})`}</text>
              </box>
              <Show when={expanded() && act.preview}>
                <box flexDirection="column" style={{ paddingLeft: 4, overflow: "hidden" }}>
                  <PreText api={api} text={act.preview ?? ""} maxLines={4} />
                </box>
              </Show>
            </box>
          )}
        </For>

        {/* outcome */}
        <box style={{ paddingLeft: 1, paddingTop: 1 }}>
          <text style={{ fg: t.text }}>Outcome</text>
        </box>
        <box flexDirection="column" style={{ paddingLeft: 1, flexGrow: 1, overflow: "hidden" }}>
          <Show when={outcome}>
            <PreText api={api} text={String(outcome)} maxLines={8} />
          </Show>
          <Show when={!outcome}>
            <text style={{ fg: t.textMuted }}>{running ? "working…" : "no outcome"}</text>
          </Show>
        </box>
      </box>
      {/* footer */}
      <box style={{ paddingLeft: 1, paddingBottom: 1 }}>
        <text style={{ fg: t.textMuted }}>{"↑↓"} agent · {"←"} {expanded() ? "collapse" : "expand"} · esc back</text>
      </box>
    </box>
  )
}

// Pre-wrapped text block (keeps newlines, hard-wraps to width)
function PromptText(props: { api: TuiPluginApi; text: string; maxLines: number }) {
  const lines = wrap(props.text, 110).slice(0, props.maxLines)
  const t = props.api.theme.current
  return (
    <For each={lines}>
      {(line) => (
        <text style={{ fg: t.text }}>
          {line || " "}
        </text>
      )}
    </For>
  )
}

function PreText(props: { api: TuiPluginApi; text: string; maxLines: number }) {
  const lines = wrap(props.text, 110).slice(0, props.maxLines)
  const t = props.api.theme.current
  return (
    <For each={lines}>
      {(line) => (
        <text style={{ fg: t.textMuted }}>
          {line || " "}
        </text>
      )}
    </For>
  )
}

function wrap(text: string, width: number): string[] {
  return String(text ?? "")
    .split("\n")
    .flatMap((line) => {
      if (line.length <= width) return [line]
      const out: string[] = []
      for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width))
      return out
    })
}

function fmtClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default plugin
