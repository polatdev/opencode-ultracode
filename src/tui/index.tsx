/** @jsxImportSource @opentui/solid */
// opencode-workflow — TUI plugin: /workflows command + progress routes.
//
// Routes:
//   workflows        — list of runs
//   workflow         — two-pane progress view (phases | agents) + log/result strip
//   workflow-agent   — agent detail (live feed / prompt / activity / outcome)
//   workflow-result  — full-screen scrollable run result
//
// State comes from /tmp/opencode-workflows/<project>/<id>/state.json, polled by the
// store and merged fine-grained so only changed cells redraw.

import type { TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createSignal } from "solid-js"
import {
  cell,
  cellR,
  clip,
  fmtAgo,
  fmtClock,
  fmtCost,
  fmtDuration,
  fmtElapsed,
  fmtTok,
  fmtTokens,
  oneLine,
  shortModel,
  wrapWords,
} from "../shared/format.ts"
import type { AgentState, PhaseState, RunState } from "../shared/state.ts"
import { createStore, isLive, type WorkflowStore } from "./store.ts"
import { createRequestStore, describeRequest, type PendingRequest, type PermissionReply, type RequestStore } from "./requests.ts"

// opentui TextAttributes bit flags (avoid a runtime import of @opentui/core)
const BOLD = 1
const DIM = 2

type Tone = "success" | "error" | "warning" | "info" | "muted" | "accent" | "text" | "primary"
type Pane = "phases" | "agents"

export const plugin: TuiPluginModule = {
  id: "opencode-workflow",
  tui: async (api) => {
    const store = createStore(api, (fn) => api.lifecycle.onDispose(fn))
    // pending permission / question requests of sub-agent sessions (see requests.ts)
    const reqs = createRequestStore(api, (fn) => api.lifecycle.onDispose(fn))

    // selection state shared across views
    const [listSel, setListSel] = createSignal(0)
    const [pane, setPane] = createSignal<Pane>("phases")
    const [agentOpenId, setAgentOpenId] = createSignal("")
    let origin: { name: string; params?: Record<string, unknown> } = { name: "home" }

    // scroll containers of the detail screens (driven from the keymap)
    let agentScroll: ScrollBoxRenderable | undefined
    let resultScroll: ScrollBoxRenderable | undefined

    const runs = () => store.runs()
    const selectedRun = (): RunState | undefined => runs()[Math.min(listSel(), Math.max(0, runs().length - 1))]
    const activeRun = (): RunState | undefined => store.activeRun()

    // keep the list cursor inside bounds when runs disappear
    createEffect(() => {
      const n = runs().length
      if (listSel() > Math.max(0, n - 1)) setListSel(Math.max(0, n - 1))
    })

    // --- navigation -----------------------------------------------------------

    const isOurRoute = (name: string) => name === "workflows" || name.startsWith("workflow")

    const openWorkflows = () => {
      const cur = api.route.current
      if (!isOurRoute(cur.name)) origin = cur as any
      api.route.navigate("workflows")
    }

    const goBack = () => {
      const cur = api.route.current.name
      if (cur === "workflow-result") {
        api.route.navigate(store.activeRunId() ? "workflow" : "workflows")
        return
      }
      if (cur === "workflow-agent" || agentOpenId()) {
        setAgentOpenId("")
        api.route.navigate("workflow")
        return
      }
      if (cur === "workflow" || store.activeRunId()) {
        store.closeRun()
        api.route.navigate("workflows")
        return
      }
      api.route.navigate(origin.name, origin.params ?? {})
    }

    const openRun = (r: RunState) => {
      store.openRun(r.runId)
      setPane("phases")
      setAgentOpenId("")
      api.route.navigate("workflow")
    }

    const currentPhase = (r: RunState): PhaseState | undefined => r.phases[store.selPhase()] ?? r.phases[0]

    const movePhase = (dir: number) => {
      const r = activeRun()
      if (!r || !r.phases.length) return
      const next = Math.max(0, Math.min(r.phases.length - 1, store.selPhase() + dir))
      if (next !== store.selPhase()) {
        store.setSelPhase(next)
        store.setSelAgent("")
      }
    }

    const moveAgentInPhase = (dir: number) => {
      const r = activeRun()
      if (!r) return
      const ids = currentPhase(r)?.agentIds ?? []
      if (!ids.length) return
      const curSel = store.selAgent()
      const cur = curSel ? ids.indexOf(curSel) : -1
      const next = Math.max(0, Math.min(ids.length - 1, (cur < 0 ? 0 : cur) + dir))
      store.setSelAgent(ids[next] ?? "")
    }

    const focusAgents = () => {
      const r = activeRun()
      if (!r) return
      const ids = currentPhase(r)?.agentIds ?? []
      if (!ids.length) {
        api.ui.toast({ variant: "info", message: "This phase has no agents yet" })
        return
      }
      if (!store.selAgent() || !ids.includes(store.selAgent()!)) store.setSelAgent(ids[0])
      setPane("agents")
    }

    const openAgent = (id: string) => {
      setAgentOpenId(id)
      store.setSelAgent(id)
      api.route.navigate("workflow-agent")
    }

    /** ←/→ in the agent view: previous / next agent of the same phase */
    const stepAgent = (dir: number) => {
      const r = activeRun()
      const a = r?.agents[agentOpenId()]
      if (!r || !a) return
      const phase = r.phases.find((p) => p.title === a.phase)
      const ids = phase?.agentIds?.length ? phase.agentIds : r.agentOrder
      const cur = ids.indexOf(a.id)
      const next = Math.max(0, Math.min(ids.length - 1, (cur < 0 ? 0 : cur) + dir))
      const id = ids[next]
      if (id && id !== a.id) {
        setAgentOpenId(id)
        store.setSelAgent(id)
        agentScroll?.scrollTo(0)
      }
    }

    const openResult = (r: RunState | undefined) => {
      if (!r) return
      if (!r.result && !r.error) {
        api.ui.toast({ variant: "info", message: isLive(r.status) ? "Run is still in progress — no result yet" : "This run produced no result" })
        return
      }
      if (store.activeRunId() !== r.runId) store.openRun(r.runId)
      api.route.navigate("workflow-result")
    }

    const scrollBy = (sb: ScrollBoxRenderable | undefined, lines: number) => {
      if (!sb) return
      try {
        sb.scrollBy({ x: 0, y: lines })
      } catch {}
    }
    const pageOf = (sb: ScrollBoxRenderable | undefined) => Math.max(3, (sb?.viewport?.height ?? sb?.height ?? 10) - 2)

    // --- actions ----------------------------------------------------------------

    const doStop = (run: RunState | undefined) => {
      if (!run) return
      if (run.status === "running" || run.status === "paused") {
        store.control(run.runId, "stop")
        api.ui.toast({ variant: "warning", message: `Stopping ${run.name}…` })
      } else {
        api.ui.toast({ variant: "info", message: `${run.name} is not running` })
      }
    }
    const doPause = (run: RunState | undefined) => {
      if (!run) return
      if (store.isStale(run) || run.status === "stopped" || run.status === "failed") {
        // no live engine: the server plugin picks the request up and restarts
        // the run in place (completed agents replay from the journal)
        store.control(run.runId, "resume")
        api.ui.toast({ variant: "info", message: `Resume requested for ${run.name} — completed agents replay, the rest run again` })
      } else if (run.status === "running") {
        store.control(run.runId, "pause")
        api.ui.toast({ variant: "info", message: `Pausing ${run.name}…` })
      } else if (run.status === "paused") {
        store.control(run.runId, "resume")
        api.ui.toast({ variant: "info", message: `Resuming ${run.name}…` })
      } else {
        api.ui.toast({ variant: "info", message: `${run.name} is not running` })
      }
    }
    const doSave = (run: RunState | undefined) => {
      if (!run) return
      const dest = store.saveScript(run)
      api.ui.toast(
        dest
          ? { variant: "success", message: `Saved as workflow: ${dest}` }
          : { variant: "error", message: "No saved script for this run" },
      )
    }
    const doDelete = (run: RunState | undefined) => {
      if (!run) return
      if (isLive(run.status) && !store.isStale(run)) {
        api.ui.toast({ variant: "error", message: "Run is active — stop it first (x), then delete (d)" })
        return
      }
      store.deleteRun(run.runId)
      api.ui.toast({ variant: "success", message: `Deleted run: ${run.name}` })
    }

    // --- permission / question requests -------------------------------------------

    /** the run and agent that own a request's session, if it is one of ours */
    const ownerOf = (p: PendingRequest): { run: RunState; agent: AgentState } | undefined => {
      for (const r of runs()) {
        for (const id of r.agentOrder) {
          const a = r.agents[id]
          if (a?.sessionId === p.sessionID) return { run: r, agent: a }
        }
      }
      return undefined
    }

    /** first agent (newest run first) that is blocked on a request */
    const firstWaiting = (): { run: RunState; agent: AgentState } | undefined => {
      for (const r of runs()) {
        const a = reqs.waitingAgents(r)[0]
        if (a) return { run: r, agent: a }
      }
      return undefined
    }

    /** `!` — jump to the first agent that needs an answer and open the dialog */
    const gotoWaiting = () => {
      const hit = firstWaiting()
      if (!hit) {
        const other = reqs.unattributed(runs()).length
        api.ui.toast({
          variant: "info",
          message: other ? `No workflow agent is waiting — ${other} request${other === 1 ? "" : "s"} pending in the chat session (esc to go back)` : "No agent is waiting for permission",
        })
        return
      }
      if (store.activeRunId() !== hit.run.runId) store.openRun(hit.run.runId)
      const phaseIdx = hit.run.phases.findIndex((p) => p.title === hit.agent.phase)
      if (phaseIdx >= 0) store.setSelPhase(phaseIdx)
      openAgent(hit.agent.id)
      respond(hit.agent)
    }

    const sendPermission = (agent: AgentState, p: PendingRequest, reply: PermissionReply) => {
      api.ui.dialog.clear()
      reqs.replyPermission(p.id, reply).then((ok) => {
        if (!ok) return
        const verb = reply === "reject" ? "Rejected" : reply === "always" ? "Allowed (always)" : "Allowed once"
        api.ui.toast({ variant: reply === "reject" ? "warning" : "success", message: `${verb}: ${clip(describeRequest(p), 60)} — ${agent.label}` })
      })
    }

    const permissionDialog = (agent: AgentState, p: Extract<PendingRequest, { kind: "permission" }>) => {
      const patterns = (p.req.patterns ?? []).filter(Boolean)
      const remember = (p.req.always ?? []).filter(Boolean)
      const what = patterns.join(", ") || p.req.permission
      const meta = p.req.metadata ?? {}
      const detail = [meta.description, meta.hint, meta.command, meta.filepath, meta.path]
        .filter((v) => typeof v === "string" && v.trim())
        .map((v) => String(v))
        .join(" · ")
      api.ui.dialog.replace(() => (
        <api.ui.DialogSelect
          title={`${p.req.permission} · ${clip(agent.label, 32)}`}
          placeholder={clip(detail || what, 70)}
          flat
          skipFilter
          options={[
            { title: "Allow once", value: "once", description: clip(what, 80) },
            {
              title: "Allow always",
              value: "always",
              description: remember.length ? `remember ${clip(remember.join(", "), 70)}` : "remember this permission for the rest of the session",
            },
            { title: "Reject", value: "reject", description: "the agent is told no and continues without it" },
          ]}
          onSelect={(o) => sendPermission(agent, p, o.value as PermissionReply)}
        />
      ))
    }

    /** ask the agent's questions one after another, then send all answers */
    const questionDialog = (agent: AgentState, p: Extract<PendingRequest, { kind: "question" }>, idx = 0, answers: string[][] = []) => {
      const qs = p.req.questions ?? []
      const q = qs[idx]
      if (!q) {
        api.ui.dialog.clear()
        reqs.replyQuestion(p.id, answers).then((ok) => ok && api.ui.toast({ variant: "success", message: `Answered ${agent.label}` }))
        return
      }
      const next = (answer: string[]) => questionDialog(agent, p, idx + 1, [...answers, answer])
      const options: Array<{ title: string; value: string; description?: string }> = q.options.map((o) => ({ title: o.label, value: `opt:${o.label}`, description: o.description }))
      if (q.custom !== false) options.push({ title: "Type an answer…", value: "__custom", description: "free-text reply" })
      options.push({ title: "Reject question", value: "__reject", description: "the agent continues without an answer" })
      api.ui.dialog.replace(() => (
        <api.ui.DialogSelect
          title={`${q.header || "Question"}${qs.length > 1 ? ` (${idx + 1}/${qs.length})` : ""} · ${clip(agent.label, 28)}`}
          placeholder={clip(q.question, 90)}
          flat
          skipFilter
          options={options}
          onSelect={(o) => {
            if (o.value === "__reject") {
              api.ui.dialog.clear()
              reqs.rejectQuestion(p.id).then((ok) => ok && api.ui.toast({ variant: "warning", message: `Rejected question from ${agent.label}` }))
              return
            }
            if (o.value === "__custom") {
              api.ui.dialog.replace(() => (
                <api.ui.DialogPrompt
                  title={clip(q.question, 70)}
                  placeholder="your answer"
                  onConfirm={(v) => next([v])}
                  onCancel={() => api.ui.dialog.clear()}
                />
              ))
              return
            }
            next([o.value.slice("opt:".length)])
          }}
        />
      ))
    }

    /** ⏎ in the agent view: answer the oldest request this agent is blocked on */
    const respond = (agent: AgentState | undefined) => {
      if (!agent) return
      const p = reqs.forAgent(agent)[0]
      if (!p) {
        api.ui.toast({ variant: "info", message: `${agent.label} is not waiting for anything` })
        return
      }
      if (p.kind === "permission") permissionDialog(agent, p)
      else questionDialog(agent, p)
    }

    // a request that arrives while we are on screen: say so, point at the key
    reqs.onNew((p) => {
      if (!isOurRoute(api.route.current.name)) return
      const owner = ownerOf(p)
      api.ui.toast({
        variant: "warning",
        title: owner ? `${owner.agent.label} needs permission` : "Permission needed in chat",
        message: owner ? `${clip(describeRequest(p), 70)} — press ! to answer` : `${clip(describeRequest(p), 70)} — esc returns to the session`,
        duration: 8000,
      })
    })

    // --- keymap -------------------------------------------------------------------

    // while one of our dialogs is up, the view keys underneath must stay quiet
    const guarded = <T extends { run: () => unknown }>(cmds: T[]): T[] =>
      cmds.map((c) => ({
        ...c,
        run: () => {
          if (api.ui.dialog.open) return
          return c.run()
        },
      }))

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
        ...guarded([
        // requests
        { name: "wf.waiting", run: () => gotoWaiting() },
        { name: "wf.agent.respond", run: () => respond(activeRun()?.agents[agentOpenId()]) },
        // list
        { name: "wf.list.up", run: () => void setListSel((v) => Math.max(0, v - 1)) },
        { name: "wf.list.down", run: () => void setListSel((v) => Math.min(Math.max(0, runs().length - 1), v + 1)) },
        { name: "wf.list.top", run: () => void setListSel(0) },
        { name: "wf.list.bottom", run: () => void setListSel(Math.max(0, runs().length - 1)) },
        { name: "wf.list.open", run: () => selectedRun() && openRun(selectedRun()!) },
        { name: "wf.list.stop", run: () => doStop(selectedRun()) },
        { name: "wf.list.pause", run: () => doPause(selectedRun()) },
        { name: "wf.list.save", run: () => doSave(selectedRun()) },
        { name: "wf.list.delete", run: () => doDelete(selectedRun()) },
        { name: "wf.list.result", run: () => openResult(selectedRun()) },
        { name: "wf.list.back", run: () => goBack() },
        // run
        { name: "wf.run.up", run: () => (pane() === "phases" ? movePhase(-1) : moveAgentInPhase(-1)) },
        { name: "wf.run.down", run: () => (pane() === "phases" ? movePhase(1) : moveAgentInPhase(1)) },
        { name: "wf.run.left", run: () => void setPane("phases") },
        { name: "wf.run.right", run: () => focusAgents() },
        { name: "wf.run.toggle", run: () => void (pane() === "phases" ? focusAgents() : setPane("phases")) },
        {
          name: "wf.run.open",
          run: () => {
            if (pane() === "phases") return focusAgents()
            const aid = store.selAgent()
            if (activeRun() && aid) openAgent(aid)
          },
        },
        { name: "wf.run.stop", run: () => doStop(activeRun()) },
        { name: "wf.run.pause", run: () => doPause(activeRun()) },
        { name: "wf.run.save", run: () => doSave(activeRun()) },
        { name: "wf.run.result", run: () => openResult(activeRun()) },
        { name: "wf.run.back", run: () => goBack() },
        // agent
        { name: "wf.agent.prev", run: () => stepAgent(-1) },
        { name: "wf.agent.next", run: () => stepAgent(1) },
        { name: "wf.agent.scrollUp", run: () => scrollBy(agentScroll, -2) },
        { name: "wf.agent.scrollDown", run: () => scrollBy(agentScroll, 2) },
        { name: "wf.agent.pageUp", run: () => scrollBy(agentScroll, -pageOf(agentScroll)) },
        { name: "wf.agent.pageDown", run: () => scrollBy(agentScroll, pageOf(agentScroll)) },
        { name: "wf.agent.expand", run: () => store.toggleExpand() },
        { name: "wf.agent.prompt", run: () => store.toggleFullPrompt() },
        { name: "wf.agent.back", run: () => goBack() },
        // result
        { name: "wf.result.scrollUp", run: () => scrollBy(resultScroll, -2) },
        { name: "wf.result.scrollDown", run: () => scrollBy(resultScroll, 2) },
        { name: "wf.result.pageUp", run: () => scrollBy(resultScroll, -pageOf(resultScroll)) },
        { name: "wf.result.pageDown", run: () => scrollBy(resultScroll, pageOf(resultScroll)) },
        { name: "wf.result.top", run: () => resultScroll?.scrollTo(0) },
        { name: "wf.result.back", run: () => goBack() },
        ]),
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
        { key: "g", cmd: "wf.list.top" },
        { key: "shift+g", cmd: "wf.list.bottom" },
        { key: "enter", cmd: "wf.list.open" },
        { key: "right", cmd: "wf.list.open" },
        { key: "l", cmd: "wf.list.open" },
        { key: "x", cmd: "wf.list.stop" },
        { key: "p", cmd: "wf.list.pause" },
        { key: "s", cmd: "wf.list.save" },
        { key: "d", cmd: "wf.list.delete" },
        { key: "r", cmd: "wf.list.result" },
        { key: "!", cmd: "wf.waiting" },
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
        { key: "tab", cmd: "wf.run.toggle" },
        { key: "enter", cmd: "wf.run.open" },
        { key: "x", cmd: "wf.run.stop" },
        { key: "p", cmd: "wf.run.pause" },
        { key: "s", cmd: "wf.run.save" },
        { key: "r", cmd: "wf.run.result" },
        { key: "!", cmd: "wf.waiting" },
        { key: "escape", cmd: "wf.run.back" },
      ],
    })
    api.keymap.registerLayer({
      mode: "wf.agent",
      bindings: [
        { key: "up", cmd: "wf.agent.scrollUp" },
        { key: "down", cmd: "wf.agent.scrollDown" },
        { key: "k", cmd: "wf.agent.scrollUp" },
        { key: "j", cmd: "wf.agent.scrollDown" },
        { key: "pageup", cmd: "wf.agent.pageUp" },
        { key: "pagedown", cmd: "wf.agent.pageDown" },
        { key: "left", cmd: "wf.agent.prev" },
        { key: "right", cmd: "wf.agent.next" },
        { key: "h", cmd: "wf.agent.prev" },
        { key: "l", cmd: "wf.agent.next" },
        { key: "e", cmd: "wf.agent.expand" },
        { key: "p", cmd: "wf.agent.prompt" },
        { key: "enter", cmd: "wf.agent.respond" },
        { key: "!", cmd: "wf.waiting" },
        { key: "escape", cmd: "wf.agent.back" },
      ],
    })
    api.keymap.registerLayer({
      mode: "wf.result",
      bindings: [
        { key: "up", cmd: "wf.result.scrollUp" },
        { key: "down", cmd: "wf.result.scrollDown" },
        { key: "k", cmd: "wf.result.scrollUp" },
        { key: "j", cmd: "wf.result.scrollDown" },
        { key: "pageup", cmd: "wf.result.pageUp" },
        { key: "pagedown", cmd: "wf.result.pageDown" },
        { key: "g", cmd: "wf.result.top" },
        { key: "escape", cmd: "wf.result.back" },
      ],
    })

    // --- routes ----------------------------------------------------------------

    api.route.register([
      {
        name: "workflows",
        render: () => {
          onCleanup(api.mode.push("wf.list"))
          return (<ListScreen api={api} store={store} reqs={reqs} sel={listSel} />) as any
        },
      },
      {
        name: "workflow",
        render: () => {
          onCleanup(api.mode.push("wf.run"))
          return (<RunScreen api={api} store={store} reqs={reqs} pane={pane} />) as any
        },
      },
      {
        name: "workflow-agent",
        render: () => {
          onCleanup(api.mode.push("wf.agent"))
          onCleanup(() => (agentScroll = undefined))
          return (
            <AgentScreen api={api} store={store} reqs={reqs} agentId={agentOpenId} scrollRef={(el) => (agentScroll = el)} />
          ) as any
        },
      },
      {
        name: "workflow-result",
        render: () => {
          onCleanup(api.mode.push("wf.result"))
          onCleanup(() => (resultScroll = undefined))
          return (<ResultScreen api={api} store={store} reqs={reqs} scrollRef={(el) => (resultScroll = el)} />) as any
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
        try {
          api.attention.notify({
            title: `Workflow ${r.status}`,
            message: `${r.name} — ${r.agentDone}/${r.agentCount} agents, ${fmtCtx(r.totalContextTokens)} context, ${fmtTokens(r.totalTokens)} billed, ${fmtCost(r.totalCost)}`,
            sound: { name: r.status === "failed" ? "error" : "done" },
          })
        } catch {}
      }
    })
  },
}

// =============================================================================
// shared bits
// =============================================================================

interface ScreenProps {
  api: TuiPluginApi
  store: WorkflowStore
  reqs: RequestStore
}

/** agent status as the UI presents it — a running agent blocked on a request is "waiting" */
function agentShownStatus(reqs: RequestStore, a: AgentState | undefined): string | undefined {
  if (!a) return undefined
  return reqs.forAgent(a).length ? "waiting" : a.status
}

/** ⚠ N agents need permission */
function waitingLabel(n: number): string {
  return `⚠ ${n} agent${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} permission`
}

/**
 * One step dimmer than textMuted: blend it ~45% toward the background. Used for
 * secondary numbers (billed tokens) that should be readable but not compete
 * with the headline value. Falls back to textMuted for non-RGB theme colors.
 */
function faintColor(c: TuiThemeCurrent): string | RGBA {
  const m = c.textMuted
  const bg = c.background
  try {
    if (!m || !bg || m.intent !== "rgb" || bg.intent !== "rgb") return m
    const [mr, mg, mb] = m.toInts()
    const [br, bgr, bb] = bg.toInts()
    const mix = (a: number, b: number) => Math.round(a * 0.55 + b * 0.45)
    const hex = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")
    return `#${hex(mix(mr, br))}${hex(mix(mg, bgr))}${hex(mix(mb, bb))}`
  } catch {
    return m
  }
}

/** context size for headline use; "—" for state files written before it was tracked */
function fmtCtx(n: number | undefined): string {
  return n == null ? "— ctx" : fmtTokens(n)
}
function fmtCtxCell(n: number | undefined): string {
  return n == null ? "—" : fmtTok(n)
}

function useTheme(api: TuiPluginApi) {
  const t = () => api.theme.current
  const faint = () => faintColor(api.theme.current)
  const tone = (which: Tone) => {
    const c = t()
    switch (which) {
      case "success":
        return c.success
      case "error":
        return c.error
      case "warning":
        return c.warning
      case "info":
        return c.info
      case "accent":
        return c.accent
      case "primary":
        return c.primary
      case "text":
        return c.text
      default:
        return c.textMuted
    }
  }
  return { t, tone, faint }
}

function statusTone(status: string | undefined): Tone {
  switch (status) {
    case "completed":
      return "success"
    case "failed":
      return "error"
    case "stopped":
    case "cancelled":
    case "paused":
    case "stale":
    case "waiting":
      return "warning"
    case "running":
      return "accent"
    default:
      return "muted"
  }
}

function statusGlyph(status: string | undefined, spinner: string): string {
  switch (status) {
    case "completed":
      return "✓"
    case "failed":
      return "✗"
    case "stopped":
    case "cancelled":
      return "■"
    case "paused":
      return "‖"
    case "stale":
      return "?"
    case "waiting":
      return "⚠"
    case "running":
      return spinner
    default:
      return "○"
  }
}

function activityTitle(a: AgentState): string {
  const thoughts = a.activity.filter((x) => x.kind === "think").length
  const tools = a.activity.length - thoughts
  if (!thoughts) return `Activity · ${tools}`
  return `Activity · ${tools} tool${tools === 1 ? "" : "s"} · ${thoughts} thought${thoughts === 1 ? "" : "s"}`
}

function statusLabel(status: string | undefined): string {
  return String(status ?? "pending")
}

/** what `p` does for this run */
function pauseLabel(store: WorkflowStore, run: RunState | undefined): string {
  if (!run) return "pause"
  if (store.isStale(run) || run.status === "paused" || run.status === "stopped" || run.status === "failed") return "resume"
  return "pause"
}

/** status as the UI should present it — a live run with a dead engine is "stale" */
function shownStatus(store: WorkflowStore, run: RunState): string {
  return store.isStale(run) ? "stale" : run.status
}

/** `key label · key label …` footer */
function Hints(props: { api: TuiPluginApi; items: Array<[string, string]> }) {
  const { t } = useTheme(props.api)
  return (
    <box flexDirection="row" style={{ paddingLeft: 2, paddingRight: 1, height: 1 }}>
      <For each={props.items}>
        {([key, label], i) => (
          <box flexDirection="row">
            <text style={{ fg: t().accent }}>{key}</text>
            <text style={{ fg: t().textMuted }}>{` ${label}${i() < props.items.length - 1 ? "   " : ""}`}</text>
          </box>
        )}
      </For>
    </box>
  )
}

/** fixed-width progress bar */
function Bar(props: { api: TuiPluginApi; done: () => number; total: () => number; width: number; tone?: () => Tone }) {
  const { t, tone } = useTheme(props.api)
  const filled = () => {
    const total = props.total()
    if (total <= 0) return 0
    return Math.max(0, Math.min(props.width, Math.round((props.done() / total) * props.width)))
  }
  return (
    <box flexDirection="row" style={{ width: props.width, height: 1 }}>
      <text style={{ fg: tone(props.tone?.() ?? "accent") }}>{"█".repeat(filled())}</text>
      <text style={{ fg: t().borderSubtle ?? t().textMuted }}>{"░".repeat(props.width - filled())}</text>
    </box>
  )
}

/** status glyph — the spinner keeps turning while running */
function Glyph(props: { api: TuiPluginApi; store: WorkflowStore; status: () => string | undefined; width?: number }) {
  const { tone } = useTheme(props.api)
  return (
    <text style={{ fg: tone(statusTone(props.status())), width: props.width ?? 2 }}>
      {statusGlyph(props.status(), props.store.spinner())}
    </text>
  )
}

/** section heading inside a detail body */
function SectionTitle(props: { api: TuiPluginApi; title: string; hint?: () => string }) {
  const { t } = useTheme(props.api)
  return (
    <box flexDirection="row" style={{ paddingTop: 1 }}>
      <text style={{ fg: t().primary, attributes: BOLD }}>{props.title}</text>
      <Show when={props.hint?.()}>
        <text style={{ fg: t().textMuted }}>{`  ${props.hint!()}`}</text>
      </Show>
    </box>
  )
}

/** word-wrapped text block, capped at maxLines with a "… N more lines" tail */
function TextBlock(props: { api: TuiPluginApi; text: () => string; width: () => number; maxLines?: number; fg?: () => any; dim?: boolean }) {
  const { t } = useTheme(props.api)
  const lines = createMemo(() => wrapWords(props.text(), props.width()))
  const shown = () => (props.maxLines ? lines().slice(0, props.maxLines) : lines())
  const hidden = () => lines().length - shown().length
  return (
    <box flexDirection="column">
      <For each={shown()}>{(line) => <text style={{ fg: props.fg?.() ?? t().text, attributes: props.dim ? DIM : 0 }}>{line || " "}</text>}</For>
      <Show when={hidden() > 0}>
        <text style={{ fg: t().textMuted }}>{`… ${hidden()} more line${hidden() === 1 ? "" : "s"}`}</text>
      </Show>
    </box>
  )
}

function keepInView(sb: ScrollBoxRenderable | undefined, index: number, rowHeight = 1) {
  if (!sb || index < 0) return
  try {
    const h = sb.viewport?.height || sb.height || 0
    if (h <= 0) return
    const top = sb.scrollTop
    const y = index * rowHeight
    if (y < top) sb.scrollTo({ x: 0, y })
    else if (y + rowHeight > top + h) sb.scrollTo({ x: 0, y: y + rowHeight - h })
  } catch {}
}

function projectName(api: TuiPluginApi): string {
  const p = api.state.path.worktree || api.state.path.directory || ""
  const parts = p.split("/").filter(Boolean)
  return parts.slice(-2).join("/") || p
}

function lastLog(run: RunState): { at: number; message: string } | undefined {
  return run.logs[run.logs.length - 1]
}

function modelsOf(run: RunState): string {
  const seen = new Set<string>()
  for (const id of run.agentOrder) {
    const m = run.agents[id]?.model
    if (m) seen.add(shortModel(m))
  }
  return [...seen].join(", ")
}

// =============================================================================
// list screen
// =============================================================================

function ListScreen(props: ScreenProps & { sel: () => number }) {
  const { api, store, reqs } = props
  const { t, tone, faint } = useTheme(api)
  const runs = store.runs
  const live = () => runs().filter((r) => isLive(r.status) && !store.isStale(r)).length
  const waiting = () => runs().reduce((n, r) => n + reqs.waitingAgents(r).length, 0)
  const waitingElsewhere = () => reqs.unattributed(runs()).length
  /** run status with a blocked agent surfaced as "waiting" */
  const rowStatus = (run: RunState) => (run.status === "running" && !store.isStale(run) && reqs.waitingAgents(run).length ? "waiting" : shownStatus(store, run))
  const wide = () => store.size().width >= 124
  // CONTEXT = live prompt size (headline); BILLED = cumulative tokens sent, faint
  const W = { icon: 2, status: 11, bar: 10, count: 8, tok: 9, billed: 9, cost: 9, time: 9, ago: 11 }
  const fixed = () => W.icon + W.status + W.bar + W.count + W.tok + W.time + (wide() ? W.billed + W.cost + W.ago : 0) + 4
  const nameW = () => Math.max(14, store.size().width - fixed() - 4)
  let sb: ScrollBoxRenderable | undefined
  createEffect(on(props.sel, (i) => keepInView(sb, i)))

  const selected = () => runs()[props.sel()]
  // the host does not constrain a route's height, so size the table from the
  // terminal: paddingTop(1) + title(1) + margin(1) + [table] + margin(1) + details(6) + hints(2) + host status line(1)
  const tableH = () => Math.max(5, store.size().height - 13)

  return (
    <box flexDirection="column" style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
      {/* title bar */}
      <box flexDirection="row" style={{ paddingLeft: 1, paddingRight: 1, height: 1 }}>
        <text style={{ fg: t().primary, attributes: BOLD }}>Workflows</text>
        <text style={{ fg: t().textMuted }}>{`  ${clip(projectName(api), 40)}`}</text>
        <text style={{ flexGrow: 1 }} />
        <Show when={waiting() > 0}>
          <text style={{ fg: t().warning, attributes: BOLD }}>{`${waitingLabel(waiting())} — ! answers   `}</text>
        </Show>
        <Show when={waiting() === 0 && waitingElsewhere() > 0}>
          <text style={{ fg: t().warning }}>{`⚠ ${waitingElsewhere()} permission${waitingElsewhere() === 1 ? "" : "s"} pending in chat — esc   `}</text>
        </Show>
        <Show when={live() > 0}>
          <text style={{ fg: t().accent }}>{`${store.spinner()} ${live()} running   `}</text>
        </Show>
        <Show when={runs().some((r) => store.isStale(r))}>
          <text style={{ fg: t().warning }}>{`? ${runs().filter((r) => store.isStale(r)).length} stale (engine gone — d deletes)   `}</text>
        </Show>
        <text style={{ fg: t().textMuted }}>{`${runs().length} run${runs().length === 1 ? "" : "s"}`}</text>
      </box>

      {/* table */}
      <box flexDirection="column" style={{ height: tableH(), border: true, borderStyle: "rounded", borderColor: t().borderActive, marginTop: 1, overflow: "hidden" }}>
        <box flexDirection="row" style={{ paddingLeft: 1, paddingRight: 1, height: 1 }}>
          <text style={{ fg: t().textMuted, width: W.icon }} />
          <text style={{ fg: t().textMuted, width: nameW() }}>NAME</text>
          <text style={{ fg: t().textMuted, width: W.status }}>STATUS</text>
          <text style={{ fg: t().textMuted, width: W.bar + W.count }}>AGENTS</text>
          <text style={{ fg: t().textMuted, width: W.tok }}>{cellR("CONTEXT", W.tok)}</text>
          <Show when={wide()}>
            <text style={{ fg: faint(), width: W.billed }}>{cellR("BILLED", W.billed)}</text>
            <text style={{ fg: t().textMuted, width: W.cost }}>{cellR("COST", W.cost)}</text>
          </Show>
          <text style={{ fg: t().textMuted, width: W.time }}>{cellR("TIME", W.time)}</text>
          <Show when={wide()}>
            <text style={{ fg: t().textMuted, width: W.ago }}>{cellR("STARTED", W.ago)}</text>
          </Show>
        </box>

        <Show when={runs().length === 0}>
          <box flexDirection="column" style={{ paddingLeft: 2, paddingTop: 1 }}>
            <text style={{ fg: t().text }}>No workflow runs yet.</text>
            <text style={{ fg: t().textMuted }}>Ask the assistant to "run a workflow" (or say "ultracode") on a large task.</text>
            <text style={{ fg: t().textMuted }}>Runs appear here live: phases, agents, tokens, and the final result.</text>
          </box>
        </Show>

        <scrollbox ref={(el) => (sb = el)} style={{ flexGrow: 1 }} scrollY={true} scrollX={false}>
          <For each={runs()}>
            {(run, idx) => {
              const isSel = () => idx() === props.sel()
              const dim = () => (isSel() ? t().text : t().textMuted)
              const elapsed = () => (run.endedAt ? run.endedAt - run.startedAt : store.now() - run.startedAt)
              return (
                <box
                  flexDirection="row"
                  style={{ paddingLeft: 1, paddingRight: 1, height: 1, backgroundColor: isSel() ? t().backgroundElement : "transparent" }}
                >
                  <Glyph api={api} store={store} status={() => rowStatus(run)} width={W.icon} />
                  <text style={{ fg: isSel() ? t().accent : t().text, width: nameW(), attributes: isSel() ? BOLD : 0 }}>
                    {cell(run.name, nameW() - 1)}
                  </text>
                  <text style={{ fg: tone(statusTone(rowStatus(run))), width: W.status, attributes: rowStatus(run) === "waiting" ? BOLD : 0 }}>{cell(statusLabel(rowStatus(run)), W.status)}</text>
                  <Bar api={api} done={() => run.agentDone} total={() => run.agentCount} width={W.bar - 1} tone={() => (run.status === "failed" ? "error" : run.status === "completed" ? "success" : "accent")} />
                  <text style={{ fg: dim(), width: W.count + 1 }}>{` ${run.agentDone}/${run.agentCount}`}</text>
                  <text style={{ fg: dim(), width: W.tok }}>{cellR(fmtCtxCell(run.totalContextTokens), W.tok)}</text>
                  <Show when={wide()}>
                    <text style={{ fg: faint(), width: W.billed }}>{cellR(fmtTok(run.totalTokens), W.billed)}</text>
                    <text style={{ fg: dim(), width: W.cost }}>{cellR(fmtCost(run.totalCost), W.cost)}</text>
                  </Show>
                  <text style={{ fg: dim(), width: W.time }}>{cellR(fmtDuration(elapsed()), W.time)}</text>
                  <Show when={wide()}>
                    <text style={{ fg: dim(), width: W.ago }}>{cellR(fmtAgo(run.startedAt, store.now()), W.ago)}</text>
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </box>

      {/* details of the selected run */}
      <Show when={selected()} keyed>
        {(run: RunState) => (
          <box
            flexDirection="column"
            style={{ border: true, borderStyle: "rounded", borderColor: t().border, paddingLeft: 1, paddingRight: 1, marginTop: 1, height: 6 }}
            title={` ${clip(run.name, 40)} `}
            titleColor={t().textMuted}
          >
            <text style={{ fg: t().text }}>{clip(oneLine(run.description) || "—", store.size().width - 8)}</text>
            <box flexDirection="row">
              <text style={{ fg: t().textMuted }}>phases </text>
              <text style={{ fg: t().text }}>{clip(run.phases.map((p: PhaseState) => `${p.title} ${p.done}/${p.agentIds.length}`).join("  ▸  ") || "—", store.size().width - 40)}</text>
              <text style={{ flexGrow: 1 }} />
              <text style={{ fg: t().textMuted }}>{clip(modelsOf(run), 28)}</text>
            </box>
            <box flexDirection="row">
              <text style={{ fg: t().textMuted }}>started </text>
              <text style={{ fg: t().text }}>{fmtClock(run.startedAt)}</text>
              <text style={{ fg: t().textMuted }}>{run.endedAt ? "   ended " : ""}</text>
              <text style={{ fg: t().text }}>{run.endedAt ? fmtClock(run.endedAt) : ""}</text>
              <text style={{ fg: t().textMuted }}>   context </text>
              <text style={{ fg: t().text }}>{fmtCtx(run.totalContextTokens)}</text>
              <text style={{ fg: faint() }}>{`   billed ${fmtTokens(run.totalTokens)}`}</text>
              <text style={{ fg: t().textMuted }}>   cost </text>
              <text style={{ fg: t().text }}>{fmtCost(run.totalCost)}</text>
            </box>
            <Show
              when={run.error}
              fallback={
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{run.result ? "result  " : "log     "}</text>
                  <text style={{ fg: run.result ? t().success : t().textMuted }}>
                    {clip(run.result ? `${oneLine(run.result)}` : lastLog(run) ? `${fmtClock(lastLog(run)!.at)}  ${oneLine(lastLog(run)!.message)}` : "—", store.size().width - 16)}
                  </text>
                </box>
              }
            >
              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>error   </text>
                <text style={{ fg: t().error }}>{clip(oneLine(run.error), store.size().width - 16)}</text>
              </box>
            </Show>
          </box>
        )}
      </Show>

      <box style={{ paddingTop: 1 }}>
        <Hints
          api={api}
          items={[
            ["↑↓", "select"],
            ["⏎", "open"],
            ["r", "result"],
            ["x", "stop"],
            ["p", pauseLabel(store, selected())],
            ["s", "save script"],
            ["d", "delete"],
            ...(waiting() > 0 ? ([["!", "answer permission"]] as Array<[string, string]>) : []),
            ["esc", "back"],
          ]}
        />
      </box>
    </box>
  )
}

// =============================================================================
// run screen
// =============================================================================

function RunScreen(props: ScreenProps & { pane: () => Pane }) {
  const { api, store } = props
  const { t } = useTheme(api)
  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <Show
        when={store.activeRun()}
        keyed
        fallback={
          <box style={{ paddingLeft: 2, paddingTop: 1 }}>
            <text style={{ fg: t().textMuted }}>no run selected — press esc to go back</text>
          </box>
        }
      >
        {(run: RunState) => <RunView api={api} store={store} reqs={props.reqs} run={run} pane={props.pane} />}
      </Show>
    </box>
  )
}

function RunView(props: ScreenProps & { run: RunState; pane: () => Pane }) {
  const { api, store, reqs, run } = props
  const { t, tone, faint } = useTheme(api)
  const width = () => store.size().width
  const narrow = () => width() < 110
  const phase = (): PhaseState | undefined => run.phases[store.selPhase()] ?? run.phases[0]
  const elapsed = () => (run.endedAt ? run.endedAt - run.startedAt : store.now() - run.startedAt)
  const live = () => isLive(run.status)
  const phasesW = () => (narrow() ? 26 : 32)
  const waiting = () => reqs.waitingAgents(run)
  const waitingIn = (p: PhaseState) => p.agentIds.some((id) => reqs.forAgent(run.agents[id]).length > 0)

  let phaseScroll: ScrollBoxRenderable | undefined
  let agentScroll: ScrollBoxRenderable | undefined
  createEffect(on(store.selPhase, (i) => keepInView(phaseScroll, i)))
  createEffect(() => {
    const ids = phase()?.agentIds ?? []
    const sel = store.selAgent()
    keepInView(agentScroll, sel ? ids.indexOf(sel) : 0)
  })

  // agent whose latest activity is shown under the table: the selected one,
  // otherwise the most recently active running agent of the phase
  const liveAgent = createMemo((): AgentState | undefined => {
    const ids = phase()?.agentIds ?? []
    const sel = store.selAgent()
    if (sel && ids.includes(sel)) return run.agents[sel]
    let best: AgentState | undefined
    for (const id of ids) {
      const a = run.agents[id]
      if (!a || a.status !== "running") continue
      const at = a.liveFeed?.[a.liveFeed.length - 1]?.at ?? a.startedAt ?? 0
      const bestAt = best?.liveFeed?.[best.liveFeed.length - 1]?.at ?? best?.startedAt ?? 0
      if (!best || at > bestAt) best = a
    }
    return best
  })
  const liveLine = () => {
    const a = liveAgent()
    if (!a) return undefined
    const blocked = reqs.forAgent(a)[0]
    if (blocked) return { label: a.label, text: `waiting for permission — ${describeRequest(blocked)}`, at: blocked.at, kind: "tool" as const, status: "waiting" }
    const f = a.liveFeed?.[a.liveFeed.length - 1]
    if (f) return { label: a.label, text: f.text, at: f.at, kind: f.kind, status: a.status }
    if (a.status === "running") return { label: a.label, text: "waiting for first output…", at: a.startedAt ?? 0, kind: "text" as const, status: a.status }
    if (a.error) return { label: a.label, text: a.error, at: a.endedAt ?? 0, kind: "text" as const, status: a.status }
    if (a.outcomeText) return { label: a.label, text: oneLine(a.outcomeText), at: a.endedAt ?? 0, kind: "text" as const, status: a.status }
    return { label: a.label, text: statusLabel(a.status), at: a.endedAt ?? a.startedAt ?? 0, kind: "text" as const, status: a.status }
  }
  const age = (at: number) => (at ? fmtAgo(at, store.now()) : "")

  // tok = CONTEXT (headline), billed = cumulative sent tokens (faint, wide only)
  const A = { icon: 2, model: 20, tok: 9, billed: 9, tools: 10, time: 9 }
  const labelW = () => Math.max(12, width() - phasesW() - 3 - 6 - A.icon - (narrow() ? 0 : A.model + A.billed) - A.tok - A.tools - A.time)

  const bottomTitle = () => (run.error ? " Error " : run.result ? " Result " : " Log ")
  // paddingTop(1) + header(4) + margin(1) + [body] + margin(1) + bottom(4) + hints(2) + host status line(1)
  const bodyH = () => Math.max(6, store.size().height - 14)
  const logLines = () => run.logs.slice(-2)

  return (
    <box flexDirection="column" style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
      {/* header */}
      <box
        flexDirection="column"
        style={{ border: true, borderStyle: "rounded", borderColor: t().border, paddingLeft: 1, paddingRight: 1, height: 4 }}
        title={` ${statusGlyph(shownStatus(store, run), store.spinner())} ${clip(run.name, 48)} `}
        titleColor={tone(statusTone(shownStatus(store, run)))}
      >
        <box flexDirection="row" style={{ height: 1 }}>
          <text style={{ fg: t().text }}>{clip(oneLine(run.description) || "—", Math.max(20, width() - 28))}</text>
          <text style={{ flexGrow: 1 }} />
          <text style={{ fg: tone(statusTone(shownStatus(store, run))), attributes: BOLD }}>{statusLabel(shownStatus(store, run)).toUpperCase()}</text>
        </box>
        <box flexDirection="row" style={{ height: 1 }}>
          <Bar api={api} done={() => run.agentDone} total={() => run.agentCount} width={narrow() ? 14 : 24} tone={() => (run.status === "failed" ? "error" : run.status === "completed" ? "success" : "accent")} />
          <text style={{ fg: t().text }}>{` ${run.agentDone}/${run.agentCount} agents`}</text>
          <text style={{ fg: t().textMuted }}>{`   ${fmtDuration(elapsed())}   ${fmtCtx(run.totalContextTokens)}`}</text>
          <text style={{ fg: faint() }}>{`   billed ${fmtTokens(run.totalTokens)}`}</text>
          <text style={{ fg: t().textMuted }}>{`   ${fmtCost(run.totalCost)}`}</text>
          <text style={{ flexGrow: 1 }} />
          <Show when={waiting().length > 0}>
            <text style={{ fg: t().warning, attributes: BOLD }}>{`${waitingLabel(waiting().length)} — ! answers   `}</text>
          </Show>
          <Show when={store.pendingControl(run.runId) === "resume"}>
            <text style={{ fg: t().warning }}>resume requested — waiting for the engine…</text>
          </Show>
          <Show when={store.pendingControl(run.runId) !== "resume" && store.isStale(run)}>
            <text style={{ fg: t().warning }}>engine gone — p resumes</text>
          </Show>
          <Show when={store.pendingControl(run.runId) !== "resume" && !store.isStale(run) && (run.status === "paused" || run.status === "stopped")}>
            <text style={{ fg: t().warning }}>{`${run.status} — p resumes`}</text>
          </Show>
          <Show when={run.status !== "paused" && !store.isStale(run) && !narrow()}>
            <text style={{ fg: t().textMuted }}>{clip(modelsOf(run), 40)}</text>
          </Show>
        </box>
      </box>

      {/* body: two panes */}
      <box flexDirection="row" style={{ height: bodyH(), marginTop: 1, gap: 1 }}>
        {/* left: phases */}
        <box
          flexDirection="column"
          style={{ width: phasesW(), border: true, borderStyle: "rounded", borderColor: props.pane() === "phases" ? t().borderActive : t().border, overflow: "hidden" }}
          title={` Phases ${run.phases.length ? `${run.phases.filter((p) => p.agentIds.length && p.done === p.agentIds.length).length}/${run.phases.length}` : ""} `}
          titleColor={props.pane() === "phases" ? t().accent : t().textMuted}
        >
          <scrollbox ref={(el) => (phaseScroll = el)} style={{ flexGrow: 1 }} scrollY={true} scrollX={false}>
            <Show when={run.phases.length === 0}>
              <box style={{ paddingLeft: 1 }}>
                <text style={{ fg: t().textMuted }}>{live() ? `${store.spinner()} starting…` : "no phases"}</text>
              </box>
            </Show>
            <For each={run.phases}>
              {(p, i) => {
                const isSel = () => store.selPhase() === i()
                const total = () => p.agentIds.length
                const running = () => p.agentIds.some((id) => run.agents[id]?.status === "running")
                const done = () => total() > 0 && p.done === total()
                const failed = () => p.agentIds.some((id) => run.agents[id]?.status === "failed")
                const blocked = () => waitingIn(p)
                const glyph = () => (blocked() ? "⚠" : running() ? store.spinner() : done() ? (failed() ? "✗" : "✓") : total() ? "◔" : "○")
                const gTone = (): Tone => (blocked() ? "warning" : running() ? "accent" : done() ? (failed() ? "error" : "success") : "muted")
                const titleW = () => phasesW() - 2 - 2 - 3 - 8 - 1
                return (
                  <box flexDirection="row" style={{ paddingLeft: 1, paddingRight: 1, height: 1, backgroundColor: isSel() ? t().backgroundElement : "transparent" }}>
                    <text style={{ fg: tone(gTone()), width: 2 }}>{glyph()}</text>
                    <text style={{ fg: t().textMuted, width: 3 }}>{`${p.index}.`.padEnd(3)}</text>
                    <text style={{ fg: isSel() ? t().accent : t().text, width: titleW(), attributes: isSel() ? BOLD : 0 }}>{cell(p.title, titleW() - 1)}</text>
                    <text style={{ fg: done() ? t().success : t().textMuted, width: 8 }}>{cellR(`${p.done}/${total()}`, 8)}</text>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </box>

        {/* right: agents of the selected phase */}
        <box
          flexDirection="column"
          style={{ flexGrow: 1, border: true, borderStyle: "rounded", borderColor: props.pane() === "agents" ? t().borderActive : t().border, overflow: "hidden" }}
          title={` ${clip(phase()?.title ?? "Agents", 30)} · ${phase()?.agentIds.length ?? 0} agent${(phase()?.agentIds.length ?? 0) === 1 ? "" : "s"} `}
          titleColor={props.pane() === "agents" ? t().accent : t().textMuted}
        >
          <Show when={phase()?.detail}>
            <box style={{ paddingLeft: 1, height: 1 }}>
              <text style={{ fg: t().textMuted }}>{clip(oneLine(phase()!.detail), width() - phasesW() - 8)}</text>
            </box>
          </Show>
          <Show when={(phase()?.agentIds.length ?? 0) === 0}>
            <box style={{ paddingLeft: 1, paddingTop: 1 }}>
              <text style={{ fg: t().textMuted }}>{live() ? `${store.spinner()} waiting for agents in this phase…` : "no agents ran in this phase"}</text>
            </box>
          </Show>
          <scrollbox ref={(el) => (agentScroll = el)} style={{ flexGrow: 1 }} scrollY={true} scrollX={false}>
            <For each={phase()?.agentIds ?? []}>
              {(aid) => {
                const a = () => run.agents[aid]
                const isSel = () => props.pane() === "agents" && store.selAgent() === aid
                const dim = () => (isSel() ? t().text : t().textMuted)
                return (
                  <Show when={a()}>
                    <box flexDirection="row" style={{ paddingLeft: 1, paddingRight: 1, height: 1, backgroundColor: isSel() ? t().backgroundElement : "transparent" }}>
                      <Glyph api={api} store={store} status={() => agentShownStatus(reqs, a())} width={A.icon} />
                      <text style={{ fg: agentShownStatus(reqs, a()) === "waiting" ? t().warning : isSel() ? t().accent : t().text, width: labelW(), attributes: isSel() || agentShownStatus(reqs, a()) === "waiting" ? BOLD : 0 }}>{cell(a()!.label, labelW() - 1)}</text>
                      <Show when={!narrow()}>
                        <text style={{ fg: dim(), width: A.model }}>{cell(shortModel(a()!.model), A.model - 1)}</text>
                      </Show>
                      <text style={{ fg: dim(), width: A.tok }}>{cellR(fmtCtxCell(a()!.contextTokens), A.tok)}</text>
                      <Show when={!narrow()}>
                        <text style={{ fg: faint(), width: A.billed }}>{cellR(fmtTok(a()!.tokens), A.billed)}</text>
                      </Show>
                      <text style={{ fg: dim(), width: A.tools }}>{cellR(a()!.toolCalls ? `${a()!.toolCalls} tool${a()!.toolCalls === 1 ? "" : "s"}` : "", A.tools)}</text>
                      <text style={{ fg: agentShownStatus(reqs, a()) === "waiting" ? t().warning : a()!.status === "running" ? t().accent : dim(), width: A.time }}>
                        {cellR(agentShownStatus(reqs, a()) === "waiting" ? "waiting" : fmtElapsed(a()!.startedAt, a()!.endedAt, store.now()), A.time)}
                      </text>
                    </box>
                  </Show>
                )
              }}
            </For>
          </scrollbox>
          {/* live strip */}
          <Show when={liveLine()} keyed={false}>
            <box flexDirection="column" style={{ paddingLeft: 1, paddingRight: 1, height: 2, marginTop: 0 }}>
              <text style={{ fg: t().borderSubtle ?? t().border }}>{"╴".repeat(Math.max(4, width() - phasesW() - 7))}</text>
              <box flexDirection="row" style={{ height: 1 }}>
                <Glyph api={api} store={store} status={() => liveLine()?.status} width={2} />
                <text style={{ fg: t().accent }}>{clip(liveLine()!.label, 22)}</text>
                <text style={{ fg: liveLine()!.kind === "tool" ? t().text : t().textMuted }}>{`  ${clip(liveLine()!.text, Math.max(10, width() - phasesW() - 46))}`}</text>
                <text style={{ flexGrow: 1 }} />
                <text style={{ fg: t().textMuted }}>{age(liveLine()!.at)}</text>
              </box>
            </box>
          </Show>
        </box>
      </box>

      {/* bottom strip: error / result / log */}
      <box
        flexDirection="column"
        style={{ border: true, borderStyle: "rounded", borderColor: run.error ? t().error : t().border, paddingLeft: 1, paddingRight: 1, marginTop: 1, height: 4, overflow: "hidden" }}
        title={bottomTitle()}
        titleColor={run.error ? t().error : run.result ? t().success : t().textMuted}
      >
        <Show when={run.error}>
          <text style={{ fg: t().error }}>{clip(oneLine(run.error), width() - 8)}</text>
          <text style={{ fg: t().textMuted }}>{lastLog(run) ? `${fmtClock(lastLog(run)!.at)}  ${clip(oneLine(lastLog(run)!.message), width() - 20)}` : ""}</text>
        </Show>
        <Show when={!run.error && run.result}>
          <text style={{ fg: t().text }}>{clip(oneLine(run.result), width() - 8)}</text>
          <text style={{ fg: t().textMuted }}>{`${wrapWords(run.result, width() - 8).length} lines · press r to read the full result`}</text>
        </Show>
        <Show when={!run.error && !run.result}>
          <Show when={logLines().length === 0}>
            <text style={{ fg: t().textMuted }}>{live() ? `${store.spinner()} starting…` : "no log lines"}</text>
          </Show>
          <For each={logLines()}>
            {(l) => (
              <box flexDirection="row" style={{ height: 1 }}>
                <text style={{ fg: t().textMuted, width: 10 }}>{fmtClock(l.at)}</text>
                <text style={{ fg: t().text }}>{clip(oneLine(l.message), width() - 18)}</text>
              </box>
            )}
          </For>
        </Show>
      </box>

      <box style={{ paddingTop: 1 }}>
        <Hints
          api={api}
          items={[
            ["↑↓", props.pane() === "phases" ? "phase" : "agent"],
            ["←→", "pane"],
            ["⏎", props.pane() === "phases" ? "agents" : "open agent"],
            ["r", "result"],
            ["x", "stop"],
            ["p", pauseLabel(store, run)],
            ["s", "save"],
            ...(waiting().length ? ([["!", "answer permission"]] as Array<[string, string]>) : []),
            ["esc", "back"],
          ]}
        />
      </box>
    </box>
  )
}

// =============================================================================
// agent screen
// =============================================================================

function AgentScreen(props: ScreenProps & { agentId: () => string; scrollRef: (el: ScrollBoxRenderable) => void }) {
  const { api, store } = props
  const { t } = useTheme(api)
  const agent = () => store.activeRun()?.agents[props.agentId()]
  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <Show
        when={agent()}
        keyed
        fallback={
          <box style={{ paddingLeft: 2, paddingTop: 1 }}>
            <text style={{ fg: t().textMuted }}>agent not found — press esc to go back</text>
          </box>
        }
      >
        {(a: AgentState) => <AgentView api={api} store={store} reqs={props.reqs} run={store.activeRun()!} agent={a} scrollRef={props.scrollRef} />}
      </Show>
    </box>
  )
}

function AgentView(props: ScreenProps & { run: RunState; agent: AgentState; scrollRef: (el: ScrollBoxRenderable) => void }) {
  const { api, store, reqs, run, agent: a } = props
  const { t, tone, faint } = useTheme(api)
  const width = () => store.size().width
  const bodyW = () => Math.max(30, width() - 8)
  const running = () => a.status === "running" || a.status === "queued"
  const pending = () => reqs.forAgent(a)
  const shown = () => agentShownStatus(reqs, a)
  const outcome = () => a.outcomeText ?? (typeof a.outcome === "string" ? a.outcome : a.outcome ? JSON.stringify(a.outcome, null, 2) : "")
  const age = (at: number) => fmtDuration(Math.max(0, store.now() - at))
  const phaseIds = () => run.phases.find((p) => p.title === a.phase)?.agentIds ?? run.agentOrder
  const pos = () => `${Math.max(0, phaseIds().indexOf(a.id)) + 1}/${phaseIds().length}`
  const feed = () => [...(a.liveFeed ?? [])].slice(-8).reverse()
  // paddingTop(1) + header(4) + margin(1) + [body] + hints(2) + host status line(1)
  const bodyH = () => Math.max(6, store.size().height - 9)

  return (
    <box flexDirection="column" style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
      {/* header */}
      <box
        flexDirection="column"
        style={{ border: true, borderStyle: "rounded", borderColor: pending().length ? t().warning : t().border, paddingLeft: 1, paddingRight: 1, height: 4 }}
        title={` ${statusGlyph(shown(), store.spinner())} ${clip(a.label, 48)} `}
        titleColor={tone(statusTone(shown()))}
      >
        <box flexDirection="row" style={{ height: 1 }}>
          <text style={{ fg: t().textMuted }}>phase </text>
          <text style={{ fg: t().text }}>{clip(a.phase || "—", 24)}</text>
          <text style={{ fg: t().textMuted }}>{`  ·  agent ${pos()}  ·  model `}</text>
          <text style={{ fg: t().text }}>{clip(a.model || "default", 40)}</text>
          <text style={{ flexGrow: 1 }} />
          <text style={{ fg: tone(statusTone(shown())), attributes: BOLD }}>{shown() === "waiting" ? "NEEDS PERMISSION" : statusLabel(a.status).toUpperCase()}</text>
        </box>
        <box flexDirection="row" style={{ height: 1 }}>
          <text style={{ fg: t().textMuted }}>context </text>
          <text style={{ fg: t().text }}>{fmtCtx(a.contextTokens)}</text>
          <text style={{ fg: faint() }}>{`  (billed ${fmtTok(a.tokens)} · out ${fmtTok(a.outputTokens)})`}</text>
          <text style={{ fg: t().textMuted }}>{`  ·  `}</text>
          <text style={{ fg: t().text }}>{fmtCost(a.cost)}</text>
          <text style={{ fg: t().textMuted }}>{`  ·  ${a.toolCalls} tool call${a.toolCalls === 1 ? "" : "s"}  ·  `}</text>
          <text style={{ fg: running() ? t().accent : t().text }}>{fmtElapsed(a.startedAt, a.endedAt, store.now())}</text>
          <text style={{ flexGrow: 1 }} />
          <text style={{ fg: t().textMuted }}>{a.startedAt ? `started ${fmtClock(a.startedAt)}` : "queued"}</text>
        </box>
      </box>

      {/* body */}
      <box flexDirection="column" style={{ height: bodyH(), border: true, borderStyle: "rounded", borderColor: t().border, marginTop: 1, overflow: "hidden" }}>
        <scrollbox ref={props.scrollRef} style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }} scrollY={true} scrollX={false}>
          {/* blocked on a permission / question — the agent cannot continue until answered */}
          <Show when={pending().length > 0}>
            <box flexDirection="row" style={{ paddingTop: 1 }}>
              <text style={{ fg: t().warning, attributes: BOLD }}>{`⚠ Waiting for your answer · ${pending().length}`}</text>
              <text style={{ fg: t().textMuted }}>{"  ⏎ opens the dialog"}</text>
            </box>
            <For each={pending()}>
              {(p) => (
                <box flexDirection="column">
                  <box flexDirection="row" style={{ height: 1 }}>
                    <text style={{ fg: t().textMuted, width: 8 }}>{cellR(age(p.at), 7)}</text>
                    <text style={{ fg: t().warning, width: 2 }}>{p.kind === "permission" ? "⚿" : "?"}</text>
                    <text style={{ fg: t().text }}>{clip(describeRequest(p), bodyW() - 12)}</text>
                  </box>
                  <Show when={p.kind === "permission" && typeof (p as any).req.metadata?.description === "string"}>
                    <text style={{ fg: t().textMuted, attributes: DIM }}>{`          ${clip(String((p as any).req.metadata.description), bodyW() - 12)}`}</text>
                  </Show>
                </box>
              )}
            </For>
          </Show>

          <Show when={a.error}>
            <SectionTitle api={api} title="Error" />
            <TextBlock api={api} text={() => a.error ?? ""} width={bodyW} fg={() => t().error} />
          </Show>

          {/* live feed while running */}
          <Show when={running()}>
            <SectionTitle api={api} title={pending().length ? "⚠ Live" : `${store.spinner()} Live`} hint={() => (pending().length ? "blocked until the request above is answered" : "newest first")} />
            <Show when={feed().length === 0}>
              <text style={{ fg: t().textMuted }}>waiting for first output…</text>
            </Show>
            <For each={feed()}>
              {(e) => (
                <box flexDirection="row" style={{ height: 1 }}>
                  <text style={{ fg: t().textMuted, width: 8 }}>{cellR(`${age(e.at)}`, 7)}</text>
                  <text style={{ fg: e.kind === "tool" ? t().accent : t().textMuted, width: 2 }}>{e.kind === "tool" ? "⚙" : e.kind === "think" ? "∴" : "…"}</text>
                  <text style={{ fg: e.kind === "tool" ? t().text : t().textMuted }}>{clip(e.text, bodyW() - 12)}</text>
                </box>
              )}
            </For>
          </Show>
          <Show when={!running() && a.liveText && !outcome()}>
            <SectionTitle api={api} title="Last output" />
            <TextBlock api={api} text={() => a.liveText ?? ""} width={bodyW} maxLines={6} dim />
          </Show>

          {/* prompt */}
          <SectionTitle api={api} title="Prompt" hint={() => (store.fullPrompt() ? "p collapses" : "p expands")} />
          <TextBlock api={api} text={() => a.prompt} width={bodyW} maxLines={store.fullPrompt() ? undefined : 6} fg={() => t().textMuted} />

          {/* activity */}
          <SectionTitle
            api={api}
            title={activityTitle(a)}
            hint={() => (a.activity.length ? (store.expandActivity() ? "e hides previews" : "e shows previews") : "no activity yet")}
          />
          <For each={a.activity}>
            {(act) => (
              <box flexDirection="column">
                <box flexDirection="row" style={{ height: 1 }}>
                  <text style={{ fg: act.endedAt ? t().success : t().accent, width: 2 }}>{act.endedAt ? "✓" : store.spinner()}</text>
                  <text style={{ fg: act.kind === "think" ? t().textMuted : t().text }}>{act.tool}</text>
                  <text style={{ fg: t().textMuted }}>{act.title && act.title !== act.tool ? `  ${clip(oneLine(act.title), Math.max(10, bodyW() - act.tool.length - 14))}` : ""}</text>
                  <text style={{ flexGrow: 1 }} />
                  <text style={{ fg: t().textMuted }}>{fmtElapsed(act.startedAt, act.endedAt, store.now())}</text>
                </box>
                <Show when={store.expandActivity() && act.preview}>
                  <box style={{ paddingLeft: 2 }}>
                    <TextBlock api={api} text={() => act.preview ?? ""} width={() => bodyW() - 2} maxLines={4} dim />
                  </box>
                </Show>
              </box>
            )}
          </For>

          {/* outcome */}
          <SectionTitle api={api} title="Outcome" />
          <Show when={outcome()} fallback={<text style={{ fg: t().textMuted }}>{running() ? `${store.spinner()} working…` : a.error ? "failed — see error above" : "no outcome"}</text>}>
            <TextBlock api={api} text={() => String(outcome())} width={bodyW} maxLines={store.fullPrompt() ? undefined : 40} />
          </Show>
          <text> </text>
        </scrollbox>
      </box>

      <box style={{ paddingTop: 1 }}>
        <Hints
          api={api}
          items={[
            ...(pending().length ? ([["⏎", pending()[0]?.kind === "question" ? "answer question" : "allow / reject"]] as Array<[string, string]>) : []),
            ["↑↓", "scroll"],
            ["←→", "prev/next agent"],
            ["e", store.expandActivity() ? "hide previews" : "show previews"],
            ["p", store.fullPrompt() ? "collapse" : "expand text"],
            ["esc", "back"],
          ]}
        />
      </box>
    </box>
  )
}

// =============================================================================
// result screen
// =============================================================================

function ResultScreen(props: ScreenProps & { scrollRef: (el: ScrollBoxRenderable) => void }) {
  const { api, store } = props
  const { t, tone, faint } = useTheme(api)
  const width = () => store.size().width
  return (
    <box flexDirection="column" style={{ flexGrow: 1 }}>
      <Show
        when={store.activeRun()}
        keyed
        fallback={
          <box style={{ paddingLeft: 2, paddingTop: 1 }}>
            <text style={{ fg: t().textMuted }}>no run selected — press esc to go back</text>
          </box>
        }
      >
        {(run: RunState) => {
          const text = () => run.error ? `${run.error}${run.result ? `\n\n${run.result}` : ""}` : run.result ?? ""
          const lines = createMemo(() => wrapWords(text(), Math.max(30, width() - 8)))
          // paddingTop(1) + title(1) + margin(1) + [body] + hints(2) + host status line(1)
          const bodyH = () => Math.max(6, store.size().height - 6)
          return (
            <box flexDirection="column" style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1, paddingTop: 1 }}>
              <box flexDirection="row" style={{ paddingLeft: 1, height: 1 }}>
                <text style={{ fg: t().primary, attributes: BOLD }}>Result</text>
                <text style={{ fg: t().textMuted }}>{`  ${clip(run.name, 48)}  ·  ${run.agentDone}/${run.agentCount} agents  ·  ${fmtDuration(run.endedAt ? run.endedAt - run.startedAt : 0)}  ·  ${fmtCtx(run.totalContextTokens)}`}</text>
                <text style={{ fg: faint() }}>{`  ·  billed ${fmtTokens(run.totalTokens)}`}</text>
                <text style={{ fg: t().textMuted }}>{`  ·  ${fmtCost(run.totalCost)}`}</text>
                <text style={{ flexGrow: 1 }} />
                <text style={{ fg: tone(statusTone(run.status)), attributes: BOLD }}>{statusLabel(run.status).toUpperCase()}</text>
              </box>
              <box flexDirection="column" style={{ height: bodyH(), border: true, borderStyle: "rounded", borderColor: run.error ? t().error : t().border, marginTop: 1, overflow: "hidden" }}>
                <scrollbox ref={props.scrollRef} style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }} scrollY={true} scrollX={false}>
                  <Show when={lines().length === 0}>
                    <text style={{ fg: t().textMuted }}>no result</text>
                  </Show>
                  <For each={lines()}>{(line) => <text style={{ fg: run.error && !run.result ? t().error : t().text }}>{line || " "}</text>}</For>
                </scrollbox>
              </box>
              <box style={{ paddingTop: 1 }}>
                <Hints
                  api={api}
                  items={[
                    ["↑↓", "scroll"],
                    ["pgup/pgdn", "page"],
                    ["g", "top"],
                    ["esc", "back"],
                  ]}
                />
              </box>
            </box>
          )
        }}
      </Show>
    </box>
  )
}

export default plugin
