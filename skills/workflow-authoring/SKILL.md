---
name: workflow-authoring
description: "Reference for authoring opencode workflow scripts: meta block, agent()/parallel()/pipeline()/phase()/log(), structured output schemas, quality patterns. Use ONLY when writing or editing a workflow script for the workflow tool."
---

# Workflow authoring (opencode-workflow)

A workflow structures work across many agents — to be comprehensive (decompose and
cover in parallel), to be confident (independent perspectives and adversarial checks
before committing), or to take on scale one context can't hold (migrations, audits,
broad sweeps). The script is where you encode that structure: what fans out, what
verifies, what synthesizes.

Hybrid tip: scout inline first (list the files, scope the diff) to discover the
work-list, then call the `workflow` tool and pipeline over it.

## Meta block (required, pure literal)

Every script starts with:

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes', // one line, shown in the approval dialog
  whenToUse: 'when tests are flaky',                // optional
  phases: [                                          // optional; one entry per phase() call
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
```

- `meta` must be a PURE LITERAL — no variables, function calls, spreads, template strings.
- Use the SAME phase titles in `meta.phases` as in `phase()` calls.
- `name` is used for saving (`s` in /workflows) and for invoking saved workflows by name.

## Script body primitives

- `agent(prompt, opts?)` → spawns a sub-agent in an isolated child session; resolves to
  its structured result (with `schema`) or final text (without). Resolves to `null` if
  the run is stopped or the user skips a failed agent — filter with `.filter(Boolean)`.
  A failed agent is retried automatically first (same session); if it still fails the
  script waits on that one result while the user retries it with a note (R) or skips
  it (X) in /workflows. Other agents keep running meanwhile.
  - `opts.label` — display name (shown in /workflows), e.g. `'tip:design'`
  - `opts.phase` — assign to a progress group (use inside pipeline/parallel stages)
  - `opts.schema` — JSON Schema; the agent is forced to return a matching JSON object
  - `opts.model` — e.g. `'anthropic/claude-sonnet-4'`; omit to inherit the session model
  - `opts.agentType` — opencode agent to run as: `'explore'` (read-only search), `'general'`,
    or any agent from the project's config. Omit for the default agent. Sub-agents never get
    the `workflow` tool, so a script cannot nest workflows.
- `parallel(thunks)` → run `Array<() => Promise>` concurrently; BARRIER (awaits all).
  A throwing thunk yields `null` in the result array — the call never rejects.
- `pipeline(items, stage1, stage2, ...)` → run each item through all stages INDEPENDENTLY,
  no barrier between stages. Stage callback receives `(prevResult, originalItem, index)`.
  A throwing stage drops that item to `null` and skips its remaining stages.
  When more agents are requested than can run at once, a later stage gets the next
  free slot before queued earlier-stage agents, so finished items flow through to the
  end instead of waiting for every item to clear the first stage.
- `phase(title)` → start a display phase; subsequent agents group under it.
- `log(message)` → narrator line in /workflows.
- `args` → value passed via the tool's `args` input (undefined if omitted).
- `budget` → `{ total, spent(), remaining() }`. `total` is null unless the user set a
  token target; once `spent()` reaches `total`, further `agent()` calls throw.

**DEFAULT TO pipeline().** Use `parallel()` (a barrier) only when stage N genuinely needs
ALL of stage N-1's results at once (dedup across findings, early-exit on zero, comparing
"the other findings"). Otherwise a barrier wastes the fast finders' time.

## Constraints in scripts

- Plain JavaScript (not TypeScript). No filesystem, no Node API, no network.
- `Date.now()`, `Math.random()`, and no-arg `new Date()` THROW (determinism for resume).
  Pass timestamps in via `args`; vary prompts/labels by index instead of randomness.
- Concurrency is capped (~min(16, cpus-2) parallel agents); the total agent cap is 1000.
- Sub-agents run in their own sessions with the project's tools and permissions — for
  long autonomous runs, pre-allow the tools agents need, or start opencode with
  `ULTRACODE_AUTO_ALLOW=1` (or a type list like `bash,edit`) so sub-agent permission
  prompts are approved automatically. The chat session itself keeps asking.

## Quality patterns

- Adversarial verify: N independent skeptics per finding prompted to REFUTE; kill if
  ≥majority refute.
- Perspective-diverse verify: distinct lenses (correctness, security, perf, repro)
  instead of N identical refuters.
- Judge panel: N independent attempts from different angles, scored by parallel judges,
  synthesize from the winner.
- Loop-until-dry: keep spawning finders until K consecutive rounds return nothing new.
- Multi-modal sweep: parallel agents each searching a different way (by-container,
  by-content, by-entity).
- Completeness critic: final agent asks "what's missing?" — its findings become the
  next round.
- No silent caps: `log()` anything you truncate top-N or drop.

## Scale

"find any bugs" → a few finders, single-vote verify. "thoroughly audit this" → larger
finder pool, 3-vote adversarial pass, synthesis stage. Runs with >25 agents are flagged
as large — expect a permission prompt for the plan either way.
