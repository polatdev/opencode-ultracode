# opencode-workflow

Multi-agent workflow orchestration for [opencode](https://opencode.ai): the model writes a small
JavaScript script that fans a task out across phases of parallel sub-agents, and you watch, pause,
resume and stop the run from a live `/workflows` view inside the TUI.

Built for work that does not fit one context: audits across many modules, multi-file migrations,
review sweeps, research with independent adversarial verification.

```
 ╭ ⠋ audit-payments ────────────────────────────────────────────────────────────────╮
 │ phases                     │ agent            model      ctx     tools   time    │
 │ ● 1 Scan          12/12    │ ✓ find:webhooks  sonnet-4   38k     6 tools 41s     │
 │ ● 2 Verify        18/24    │ ⠋ verify:idem-2  sonnet-4   21k     3 tools 12s     │
 │ ○ 3 Synthesize     0/1     │ ⠋ verify:idem-3  qwen3.8    17k     2 tools  9s     │
 │                            │ ○ verify:retry-1 sonnet-4                            │
 ╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴
 │ ⠋ verify:idem-2   grep done · src/Services/Payment                        3s ago │
 ╰──────────────────────────────────────────────────────────────────────────────────╯
  ↑↓ agent  ←→ pane  ⏎ open agent  r result  x stop  p pause  s save  esc back
```

## What you get

- **`workflow` tool** for the model, plus keyword triggers ("run a workflow", "ultracode") and a
  system-prompt nudge so the model proposes a workflow when a task is clearly too big for one pass.
- **Script primitives**: `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`.
  Agents can be forced to return JSON matching a schema and can run on different models.
- **Plan approval** through opencode's normal permission flow before anything runs.
- **Live TUI** (`/workflows`): run list, two-pane phase/agent view, agent detail with live feed,
  thinking blocks, tool activity and outcome, full-screen result view.
- **Sub-agent permission and question requests** surface inside the workflow views, so a blocked
  agent is never just "running" forever. Answer them without leaving the screen.
- **Pause / resume / stop**, and **crash recovery**: if opencode exits mid-run, completed agents
  replay from a journal and only the rest run again.
- **Token accounting per agent**: current context size, billed total, output tokens and cost.
- **Saved workflows**: keep a script as `.opencode/workflows/<name>.js` and start it by name.
- **Bundled `workflow-authoring` skill** that teaches the model the script format and quality
  patterns. It is registered automatically in every project the plugin is loaded in.

## Requirements

- opencode `>= 1.3.4` (the plugin is loaded as TypeScript source, no build step)
- Node.js 22+ for the local self-test

## Install

```bash
git clone https://github.com/polatdev/opencode-workflows.git
cd opencode-workflows
npm install
```

The project ships two plugins that must both be registered: the **server plugin** (tool, engine,
skill) and the **TUI plugin** (the `/workflows` screens).

### Globally, for every project

Server plugin: create `~/.config/opencode/plugin/opencode-workflow.ts` that re-exports the entry point.

```ts
export { default } from "/absolute/path/to/opencode-workflows/src/server/index.ts"
```

TUI plugin: add the entry to `~/.config/opencode/tui.json`.

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/opencode-workflows/src/tui/index.tsx"]
}
```

### Per project

Add the paths to the project's `opencode.json` and `tui.json` instead.

```json
// opencode.json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["./path/to/src/server/index.ts"] }
```

```json
// tui.json
{ "$schema": "https://opencode.ai/tui.json", "plugin": ["./path/to/src/tui/index.tsx"] }
```

Restart opencode. `/workflows` should now open the run list.

## Usage

Ask for it in plain words. Any of these make the model call the tool immediately:

> run a workflow that audits every payment handler for missing idempotency checks
>
> ultracode: migrate all repositories from Doctrine to Eloquent

For a large task you did not phrase this way, the model recommends a workflow (phases and rough
agent count) and waits for your go-ahead.

The flow is:

1. The model authors a script (or picks a saved one) and calls `workflow`.
2. opencode shows a permission prompt with the plan: name, description, phases.
3. The run starts in the background. Open `/workflows` to watch it.
4. When the run finishes, its result is delivered as a new turn in the session that started it.

### Writing a script

Scripts are plain JavaScript. They must begin with a pure-literal `meta` block, then use the
primitives below. The bundled `workflow-authoring` skill has the full reference and patterns.

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }, { title: 'Synthesize' }],
}

const FINDING = { type: 'object', properties: { findings: { type: 'array' } }, required: ['findings'] }
const VERDICT = { type: 'object', properties: { isReal: { type: 'boolean' }, why: { type: 'string' } }, required: ['isReal'] }

const dims = [
  { key: 'bugs', prompt: 'Review the current diff for correctness bugs…' },
  { key: 'perf', prompt: 'Review the current diff for performance problems…' },
]

// pipeline: each dimension moves to Verify as soon as its own Review is done
const verified = await pipeline(
  dims,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDING }),
  r => parallel((r?.findings ?? []).map(f => () =>
    agent(`Try to REFUTE this finding: ${JSON.stringify(f)}`, { label: `verify:${f.file}`, phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, verdict: v }))
  )),
)

phase('Synthesize')
const confirmed = verified.flat().filter(Boolean).filter(f => f.verdict?.isReal)
log(`${confirmed.length} confirmed findings`)
return await agent(`Write the final report for these findings: ${JSON.stringify(confirmed)}`, { label: 'report' })
```

| Primitive | What it does |
| --- | --- |
| `agent(prompt, opts?)` | Spawns a sub-agent in its own session. Resolves to the schema-validated object or final text, `null` on failure or stop. `opts`: `label`, `phase`, `schema`, `model`. |
| `parallel(thunks)` | Runs `Array<() => Promise>` concurrently and waits for all. A throwing thunk becomes `null`. |
| `pipeline(items, ...stages)` | Runs each item through every stage independently, no barrier between stages. Default choice. |
| `phase(title)` | Starts a display phase. Use the same titles as `meta.phases`. |
| `log(message)` | Narrator line shown in the run view. |
| `args` | Whatever the tool call passed as `args`. |
| `budget` | `{ total, spent(), remaining() }`. `agent()` throws once `total` is reached. |

Constraints: no filesystem, network or Node APIs inside a script. `Date.now()`, `Math.random()`
and no-arg `new Date()` throw so a resumed run replays deterministically. Concurrency is capped
at roughly `min(16, cpus - 2)` agents at a time, 1000 agents per run.

### Tool arguments

| Argument | Meaning |
| --- | --- |
| `script` | Inline workflow script |
| `scriptPath` | Path to a script file |
| `name` | Saved workflow from `.opencode/workflows/<name>.js` |
| `args` | Value exposed to the script as `args` |
| `resumeRunId` | Resume a stopped run or one whose engine died |

## The `/workflows` TUI

| Screen | Keys |
| --- | --- |
| Run list | `↑↓` select · `⏎` open · `r` result · `x` stop · `p` pause / resume · `s` save script · `d` delete · `esc` back |
| Run view | `↑↓` phase or agent · `←→` switch pane · `⏎` open · `r` result · `x` stop · `p` pause / resume · `s` save · `!` answer a pending permission |
| Agent detail | `↑↓` scroll · `←→` previous / next agent · `e` show tool and thinking previews · `p` expand prompt · `⏎` answer a permission or question |
| Result view | `↑↓` scroll · `g` top |

The agent detail shows a **Live** feed while the agent runs (text, thinking marked `∴`, tool calls
marked `⚙`, newest first), the prompt, an **Activity** list with one row per tool call and per
thinking block with its duration, and the final outcome.

```
Activity · 3 tools · 2 thoughts                                    e shows previews
✓ grep    /Users/me/PhpstormProjects/payzink-api                              0s
✓ think   Retry logic lives in the webhook handler, so the idempotency…      16s
✓ read    src/Services/Payment/RetryService.php                               1s
⠋ think   Comparing the two idempotency checks…                               3s
```

Thinking rows appear only when the provider streams reasoning; with thinking disabled the list
holds tool calls only.

## Where things live

| Path | Contents |
| --- | --- |
| `/tmp/opencode-workflows/<project>-<hash>/<runId>/` | Run artifacts: `state.json`, `journal.jsonl`, `script.js`, `control.json`. Scratch data, safe to delete. |
| `<project>/.opencode/workflows/<name>.js` | Saved workflows (`s` in the TUI). Project assets, commit them if you like. |
| `skills/workflow-authoring/` | The bundled authoring skill, registered through the plugin's `config` hook. |

The TUI polls `state.json` and merges it fine-grained, so only changed cells redraw. Pause,
resume and stop are written to `control.json` and picked up by the engine. A `resume` on a run
with no live engine asks the server plugin to restart it: completed agents replay from the
journal, the rest run again, and the result is delivered to the original session.

## Development

```bash
npm run typecheck      # tsc --noEmit
npm run test:runtime   # engine self-test against a mock opencode client
```

```
src/
  server/index.ts   server plugin: workflow tool, triggers, system guidance, usage tracking
  runtime/engine.ts run engine: agents, phases, journal, resume, state file
  runtime/script.ts script parsing and deterministic sandbox
  runtime/schema.ts structured-output schema handling
  tui/index.tsx     TUI plugin: /workflows routes and keymaps
  tui/store.ts      state.json polling and fine-grained merge
  tui/requests.ts   pending permission / question tracking for sub-agents
  shared/           types and formatting shared by both plugins
skills/workflow-authoring/SKILL.md
```

## License

Not yet specified.
