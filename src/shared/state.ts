// Shared types between the server plugin (engine) and the TUI plugin (views).
// The state file written by the server is the single source of truth the TUI polls.

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
  /** tool name, e.g. "StructuredOutput" or "bash" */
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
  /** tokens used so far (input+output+reasoning+cache reads) */
  tokens: number
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
  startedAt?: number
  endedAt?: number
  error?: string
  sessionId?: string
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
  /** total tokens across all agents */
  totalTokens: number
  totalCost: number
  /** resolved script path (for save) */
  scriptPath?: string
  /** the workflow's final return value (stringified for storage) */
  result?: string
  /** error message if failed */
  error?: string
  /** the directory this run was created in */
  directory: string
}

export interface ControlState {
  pause?: boolean
  stop?: boolean
}

// --- wire helpers -----------------------------------------------------------

export function runDir(workflowDir: string, runId: string): string {
  return `${workflowDir}/runs/${runId}`
}
export function statePath(workflowDir: string, runId: string): string {
  return `${runDir(workflowDir, runId)}/state.json`
}
export function controlPath(workflowDir: string, runId: string): string {
  return `${runDir(workflowDir, runId)}/control.json`
}
export function journalPath(workflowDir: string, runId: string): string {
  return `${runDir(workflowDir, runId)}/journal.jsonl`
}
export function workflowRoot(worktree: string): string {
  return `${worktree}/.opencode/workflows`
}
