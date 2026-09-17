// Shared types between the server plugin (engine) and the TUI plugin (views).
// The state file written by the server is the single source of truth the TUI polls.

import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { basename } from "node:path"

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "stopped"

export type AgentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export interface PhaseDef {
  title: string
  detail?: string
  model?: string
}

export interface PhaseState extends PhaseDef {
  /** 1-based progress index shown in the left pane */
  index: number
  /** agent ids that belong to this phase, in spawn order */
  agentIds: string[]
  /** how many of those agents reached a terminal state */
  done: number
}

export interface AgentActivity {
  /** "tool" (default) for tool calls, "think" for a reasoning/thinking block */
  kind?: "tool" | "think"
  /** host tool-call id (when the host sends one) — used to match updates */
  callId?: string
  /** tool name, e.g. "StructuredOutput" or "bash"; "think" for reasoning entries */
  tool: string
  /** short title / first words of the call */
  title: string
  /** preview of the result (truncated) */
  preview?: string
  startedAt: number
  endedAt?: number
}

export interface AgentState {
  id: string
  /** display label, e.g. "tip:design" */
  label: string
  /** phase title this agent runs under */
  phase: string
  phaseIndex: number
  status: AgentStatus
  /** resolved model, e.g. "anthropic/claude-sonnet-4" or "qwen3.8" */
  model: string
  /**
   * BILLED tokens: sum over every API call this agent made of
   * input+output+reasoning+cache read/write. Each call re-sends the whole
   * context, so this grows quadratically with tool-call count and is much
   * larger than the context size. Matches `cost`.
   */
  tokens: number
  /**
   * CONTEXT size: prompt tokens (input + cache read/write) of the LATEST API
   * call, i.e. how big the agent's context actually is right now.
   */
  contextTokens: number
  outputTokens: number
  cost: number
  toolCalls: number
  activity: AgentActivity[]
  prompt: string
  outcome?: unknown
  /** raw final text (truncated for display) */
  outcomeText?: string
  /** latest LLM text chunk seen while the agent is running (live view) */
  liveText?: string
  /** recent live activity (text chunks, thinking, tool calls), newest last, capped */
  liveFeed?: { at: number; kind: "text" | "tool" | "think"; text: string }[]
  startedAt?: number
  endedAt?: number
  error?: string
  sessionId?: string
  /** true when this agent's result was replayed from a previous run of the same runId (resume) */
  replayed?: boolean
}

export interface RunLogEntry {
  at: number
  message: string
}

export interface RunState {
  runId: string
  status: RunStatus
  /** workflow meta */
  name: string
  description: string
  whenToUse?: string
  /** phases in display order (from meta.phases, plus any discovered) */
  phases: PhaseState[]
  /** every agent, in spawn order */
  agents: Record<string, AgentState>
  /** agent ids in spawn order */
  agentOrder: string[]
  logs: RunLogEntry[]
  /** total agents spawned so far */
  agentCount: number
  /** agents that reached a terminal state */
  agentDone: number
  startedAt: number
  endedAt?: number
  /** total BILLED tokens across all agents (see AgentState.tokens) */
  totalTokens: number
  /** sum of every agent's current context size (see AgentState.contextTokens) */
  totalContextTokens: number
  totalCost: number
  /** resolved script path (for save) */
  scriptPath?: string
  /** the workflow's final return value (stringified for storage) */
  result?: string
  /** error message if failed */
  error?: string
  /** the directory this run was created in */
  directory: string
  /** opencode session that started the run; the result turn is delivered here (also after a resume) */
  mainSessionID?: string
  /** model the starting session used; agents without an explicit model inherit it (needed to resume) */
  defaultModel?: string
  /** the script's `args` value, kept so a resume re-runs the script with the same input */
  args?: unknown
  /** set when the run was resumed after its engine died (opencode exit/crash) */
  resumedAt?: number
  /** how many times the run has been resumed */
  resumeCount?: number
}

/**
 * control.json written by the TUI. A live engine polls it for pause/resume/stop.
 * `resume` on a run with no live engine (opencode exited while it ran) asks the
 * server plugin to restart the run: completed agents replay from the journal,
 * the rest run again.
 */
export interface ControlState {
  action?: "pause" | "resume" | "stop"
  pause?: boolean
  resume?: boolean
  stop?: boolean
  at?: number
}

// --- wire helpers -----------------------------------------------------------

/**
 * Where run artifacts (state.json, journal.jsonl, script.js, control.json) live:
 * /tmp/opencode-workflows/<project-name>-<hash6>. Runs are scratch data, so they
 * stay out of the project tree; the hash suffix keeps two projects with the same
 * folder name (e.g. two "api" checkouts) from sharing a run list.
 * Saved workflows (<name>.js) are project assets and stay under workflowRoot().
 */
export function runsRoot(worktree: string): string {
  const base = process.platform === "win32" ? tmpdir() : "/tmp"
  const name = (basename(worktree) || "project").replace(/[^a-zA-Z0-9._-]/g, "-")
  const hash = createHash("sha1").update(worktree).digest("hex").slice(0, 6)
  return `${base}/opencode-workflows/${name}-${hash}`
}
export function runDir(runsRootDir: string, runId: string): string {
  return `${runsRootDir}/${runId}`
}
export function statePath(runsRootDir: string, runId: string): string {
  return `${runDir(runsRootDir, runId)}/state.json`
}
export function controlPath(runsRootDir: string, runId: string): string {
  return `${runDir(runsRootDir, runId)}/control.json`
}
export function journalPath(runsRootDir: string, runId: string): string {
  return `${runDir(runsRootDir, runId)}/journal.jsonl`
}
/** saved (named) workflow scripts: <worktree>/.opencode/workflows/<name>.js */
export function workflowRoot(worktree: string): string {
  return `${worktree}/.opencode/workflows`
}
