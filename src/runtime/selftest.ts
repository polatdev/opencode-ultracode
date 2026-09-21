// Standalone engine test: runs workflow scripts against a mocked opencode client.
// Usage: node src/runtime/selftest.ts

import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert"
import { generateRunId, loadPriorRun, RunEngine } from "./engine.ts"
import { parseScript } from "./script.ts"

const tmp = mkdtempSync(join(tmpdir(), "wf-selftest-"))
const opencodeDir = join(tmp, ".opencode")
const runsRoot = join(tmp, "runs")

let sessionSeq = 0
let promptCount = 0
const seenSessions: string[] = []

const fakeClient = {
  session: {
    async create(args: any) {
      const id = `ses_fake_${++sessionSeq}`
      seenSessions.push(id)
      console.log(`  [mock] session.create  title=${args.body?.title} -> ${id}`)
      return { id, parentID: args.body?.parentID }
    },
    async prompt(args: any) {
      promptCount++
      const id = args.path.id
      const text = String(args.body?.parts?.[0]?.text ?? "")
      console.log(`  [mock] session.prompt  ${id} model=${args.body?.model ? JSON.stringify(args.body.model) : "(inherit)"} chars=${text.length}`)
      // emulate the model: if the task asks for JSON tips, return JSON; synthesis returns JSON report
      if (/\bJSON\b/i.test(text)) {
        if (/synthes/i.test(text)) {
          const extracted = text.match(/\[.*\]/s)?.[0]
          let parsed: any[] = []
          try {
            parsed = JSON.parse(extracted ?? "[]")
          } catch {}
          const best = parsed.slice(0, 3).map((p: any) => p?.tip ?? "")
          return {
            info: assistantMsg(id),
            parts: [{ type: "text", id: "p1", sessionID: id, messageID: "m1", text: JSON.stringify({ report: { count: best.length, best }, }) }],
          }
        }
        const angleMatch = text.match(/about (\w+) multi-agent workflows/i)
        const angle = angleMatch?.[1] ?? "general"
        return {
          info: assistantMsg(id),
          parts: [{ type: "text", id: "p1", sessionID: id, messageID: "m1", text: JSON.stringify({ angle: `${angle} multi-agent workflows: mock tip`, tip: `A mock tip about ${angle}.` }) }],
        }
      }
      return {
        info: assistantMsg(id),
        parts: [{ type: "text", id: "p1", sessionID: id, messageID: "m1", text: "plain text answer" }],
      }
    },
    async abort(args: any) {
      console.log(`  [mock] session.abort ${args.path.id}`)
      return true
    },
  },
}

function assistantMsg(sessionID = "x") {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    sessionID,
    role: "assistant",
    time: { created: Date.now(), completed: Date.now() },
    parentID: "p",
    modelID: "mock-model",
    providerID: "mock",
    mode: "workflow",
    path: { cwd: "/", root: "/" },
    cost: 0.001,
    tokens: { input: 10_000, output: 3_600, reasoning: 0, cache: { read: 20_000, write: 500 } },
  }
}

const DEMO = `
export const meta = {
  name: "demo-fanout",
  description: "Demo: 3 agents write tips on multi-agent workflows, 1 agent synthesizes",
  phases: [
    { title: "Generate", detail: "3 agents, one tip each" },
    { title: "Synthesize", detail: "merge the tips into the final set" },
  ],
}

const ANGLES = ["design", "execution", "debugging"]

phase("Generate")
const results = await parallel(ANGLES.map((a) => () =>
  agent(
    \`Write one concise tip (2-3 sentences) about \${a.toUpperCase()} multi-agent workflows: concurrency limits, token budget, and isolation. Respond with JSON.\`,
    {
      label: \`tip:\${a}\`,
      schema: { type: "object", properties: { angle: { type: "string" }, tip: { type: "string" } }, required: ["angle", "tip"] },
    },
  ),
))
const tips = results.filter(Boolean)
log(\`\${tips.length}/\${ANGLES.length} tips generated\`)

phase("Synthesize")
const final = await agent(
  \`Synthesize these tips into the single best set (pick up to 3). Respond with JSON. Tips: \${JSON.stringify(tips, null, 2)}\`,
  {
    label: "tip:synthesis",
    schema: { type: "object", properties: { report: { type: "object" } }, required: ["report"] },
  },
)
return { tips, final }
`

async function main() {
  // ---- test 1: meta parsing ------------------------------------------------
  console.log("test 1: parseScript meta + body")
  const parsed = parseScript(DEMO)
  assert.equal(parsed.meta.name, "demo-fanout")
  assert.equal(parsed.meta.phases?.length, 2)
  assert.ok(!/^export\s+const\s+meta/m.test(parsed.body.trimStart()), "body should not retain meta")
  assert.ok(parsed.body.includes("parallel("))
  console.log("  ok: meta parsed, body clean")

  const bad = () => parseScript("const meta = { name: 'x' };\nagent('hi')")
  assert.throws(bad, /must start with/)
  const impure = `export const meta = { name: "x", description: f() };\nphase("a")`
  // f() is a call — our lint only bans functions/new/if/while/arrow; a plain call() would pass lint
  // and blow up at eval time: still an error either way
  assert.throws(() => parseScript(impure), /meta|moust|literal|name|description/i)
  console.log("  ok: invalid scripts rejected")

  // ---- test 2: full demo run ----------------------------------------------
  console.log("test 2: full demo-fanout run (4 agents)")
  const runId = generateRunId()
  const engine = new RunEngine(
    { client: fakeClient as any, opencodeDir, runsRoot, mainSessionID: "ses_main", defaultModel: "mock/sonnet", availableModels: new Set(["mock/sonnet", "mock/haiku"]), runArgs: { extra: 1 } },
    runId,
  )
  const t0 = Date.now()
  const res = await engine.run({ script: DEMO })
  const dt = Date.now() - t0
  console.log(`  result: status=${res.status} in ${dt}ms`)
  assert.equal(res.status, "completed", `expected completed, error=${res.error}`)
  assert.ok(res.result, "expected a result payload")
  const result = JSON.parse(res.result!)
  assert.ok(Array.isArray(result.tips) && result.tips.length === 3, "expected 3 tips")
  assert.ok(result.final?.report?.best?.length <= 3, "expected synthesized report")

  // state file
  const state = JSON.parse(readFileSync(join(runsRoot, runId, "state.json"), "utf8"))
  assert.equal(state.status, "completed")
  assert.equal(state.agentCount, 4)
  assert.equal(state.agentDone, 4)
  assert.equal(state.phases.length, 2)
  assert.equal(state.phases[0].title, "Generate")
  assert.equal(state.phases[0].agentIds.length, 3)
  assert.equal(state.phases[1].agentIds.length, 1)
  const labels = state.agentOrder.map((id: string) => state.agents[id].label)
  assert.deepEqual(labels, ["tip:design", "tip:execution", "tip:debugging", "tip:synthesis"])
  const synth = state.agents[state.agentOrder[3]]
  assert.equal(synth.model, "mock/sonnet", "agent should inherit session model")
  assert.ok(synth.tokens > 0, "tokens tracked")
  // mock message: input 10k + cache read 20k + cache write 500 = 30.5k context per call
  assert.equal(synth.contextTokens, 30_500, "context = prompt size of the latest call")
  assert.ok(synth.tokens >= synth.contextTokens + 3_600, "billed includes output on top of context")
  assert.ok(synth.outcome, "outcome stored")
  assert.ok(state.totalTokens > 0)
  assert.equal(
    state.totalContextTokens,
    state.agentOrder.reduce((n: number, id: string) => n + state.agents[id].contextTokens, 0),
    "run context = sum of agent contexts",
  )
  console.log(`  ok: state.json (4 agents, 2 phases, billed=${state.totalTokens}, context=${state.totalContextTokens})`)

  // journal
  const journal = readFileSync(join(runsRoot, runId, "journal.jsonl"), "utf8").trim().split("\n")
  assert.ok(journal.length >= 9, `journal lines = ${journal.length}`)
  const kinds = journal.map((l) => JSON.parse(l).type)
  assert.ok(kinds.includes("run-start") && kinds.includes("run-end"))
  assert.equal(kinds.filter((k: string) => k === "agent-start").length, 4)
  assert.equal(kinds.filter((k: string) => k === "agent-done").length, 4)
  console.log("  ok: journal (run-start, 4x agent-start/done, run-end)")

  // script.js persisted
  assert.ok(existsSync(join(runsRoot, runId, "script.js")), "script.js persisted")
  console.log("  ok: script.js persisted")

  // ---- test 3: deterministic sandbox ---------------------------------------
  console.log("test 3: sandbox blocks Date.now / Math.random / fetch / process")
  const S1 = `
export const meta = { name: "t3", description: "sandbox", phases: [{ title: "A" }] }
phase("A")
try { Date.now() } catch (e) { log("date-now-blocked:" + (String(e.message).includes("not available"))) }
try { Math.random() } catch (e) { log("math-random-blocked:" + (String(e.message).includes("not available"))) }
try { fetch("http://x") } catch (e) { log("fetch-blocked:" + (String(e.message).includes("not available"))) }
try { process.exit } catch (e) { log("process-blocked:" + true) }
await agent("say hi", { label: "t3a" })
return "done"
`
  const rid3 = generateRunId()
  const e3 = new RunEngine({ client: fakeClient as any, opencodeDir, runsRoot, mainSessionID: "ses_main", availableModels: new Set() }, rid3)
  const r3 = await e3.run({ script: S1 })
  assert.equal(r3.status, "completed")
  const s3 = JSON.parse(readFileSync(join(runsRoot, rid3, "state.json"), "utf8"))
  const logs = s3.logs.map((l: any) => l.message).join(" | ")
  console.log(`  logs: ${logs}`)
  assert.ok(logs.includes("date-now-blocked:true"))
  assert.ok(logs.includes("math-random-blocked:true"))
  assert.ok(logs.includes("fetch-blocked:true"))
  assert.ok(logs.includes("process-blocked:true"))
  console.log("  ok: sandbox blocks verified")

  // Date with args still works
  const S2 = `
export const meta = { name: "t3b", description: "date-with-args", phases: [{ title: "A" }] }
phase("A")
log("date-ok:" + (new Date(1700000000000).getTime() === 1700000000000))
return 42
`
  const rid3b = generateRunId()
  const e3b = new RunEngine({ client: fakeClient as any, opencodeDir, runsRoot, mainSessionID: "ses_main", availableModels: new Set() }, rid3b)
  const r3b = await e3b.run({ script: S2 })
  assert.equal(r3b.status, "completed")
  const s3b = JSON.parse(readFileSync(join(runsRoot, rid3b, "state.json"), "utf8"))
  assert.ok(s3b.logs.some((l: any) => l.message === "date-ok:true"))
  assert.equal(r3b.result, "42")
  console.log("  ok: new Date(ts) + return values work")

  // ---- test 4: pipeline stages (no barrier) + error -> null -----------------
  console.log("test 4: pipeline + error handling")
  const S4 = `
export const meta = { name: "t4", description: "pipeline", phases: [{ title: "P" }] }
phase("P")
const items = ["a", "b", "c"]
const out = await pipeline(items,
  (prev, item) => agent("work on " + item, { label: "work:" + item }),
  (prev, item, i) => { if (item === "b") throw new Error("boom"); return prev + "/" + i },
)
const bad = await parallel([() => agent("fine"), () => Promise.reject(new Error("nope"))])
log("pipeline:" + out.map(x => x ?? "null").join(","))
log("parallel-nulls:" + bad.filter(Boolean).length + "/" + bad.length)
return out
`
  const rid4 = generateRunId()
  const e4 = new RunEngine({ client: fakeClient as any, opencodeDir, runsRoot, mainSessionID: "ses_main", availableModels: new Set() }, rid4)
  const r4 = await e4.run({ script: S4 })
  assert.equal(r4.status, "completed")
  const s4 = JSON.parse(readFileSync(join(runsRoot, rid4, "state.json"), "utf8"))
  const l4 = s4.logs.map((l: any) => l.message).join(" | ")
  console.log(`  logs: ${l4}`)
  const pm = l4.match(/pipeline:(.*) \| parallel-nulls/)
  assert.ok(pm, `no pipeline line: ${l4}`)
  const line = pm[1] // "<item0>,<item1>,<item2>" where item1 is null
  const mid = line.indexOf(",null,")
  assert.ok(mid > 0, `expected a null middle item: ${line}`)
  assert.ok(line.slice(0, mid).endsWith("/0"), `item0 should end with /0: ${line.slice(0, mid)}`)
  assert.ok(line.endsWith("/2"), `item2 should end with /2: ${line}`)
  assert.ok(line.slice(mid + 6).startsWith("{"), `item2 should be a result object: ${line}`)
  assert.ok(l4.includes("parallel-nulls:1/2"))
  const failed = s4.agentOrder.map((id: string) => s4.agents[id]).filter((a: any) => a.status === "failed")
  assert.equal(failed.length, 0, "pipeline stage throw should drop item, not fail agent (agent itself succeeded)")
  console.log("  ok: pipeline stages, item drop on stage error, parallel null on reject")

    // ---- test 5: resume after the engine died ----------------------------------
  console.log("test 5: resume a stopped run (completed agents replay from the journal)")
  {
    const rid = generateRunId()
    const deps = { client: fakeClient as any, opencodeDir, runsRoot, mainSessionID: "ses_main", defaultModel: "mock/sonnet", availableModels: new Set(["mock/sonnet"]) }
    const e1 = new RunEngine(deps, rid)
    // make the synthesis agent die mid-run: stop the run once the Generate phase is done
    const origPrompt = fakeClient.session.prompt
    let calls = 0
    fakeClient.session.prompt = async (args: any) => {
      calls++
      if (calls === 4) {
        e1.shutdown("opencode exited while the workflow was running")
        throw new Error("connection closed")
      }
      return origPrompt(args)
    }
    const r1 = await e1.run({ script: DEMO, args: { extra: 7 } })
    fakeClient.session.prompt = origPrompt
    assert.equal(r1.status, "stopped", `expected stopped, got ${r1.status} (${r1.error})`)
    const s1: any = JSON.parse(readFileSync(join(runsRoot, rid, "state.json"), "utf8"))
    assert.equal(s1.mainSessionID, "ses_main")
    assert.deepEqual(s1.args, { extra: 7 })
    const done1 = Object.values(s1.agents).filter((a: any) => a.status === "completed").length
    assert.equal(done1, 3, `3 tip agents should have completed before the stop (got ${done1})`)

    const prior = loadPriorRun(runsRoot, rid)
    assert.ok(prior, "prior run loads")
    assert.equal(prior!.replayable, 3)
    const before = promptCount
    const e2 = new RunEngine(deps, rid)
    const r2 = await e2.run({ resume: prior! })
    assert.equal(r2.status, "completed", `resumed run should complete, error=${r2.error}`)
    assert.equal(promptCount - before, 1, "only the synthesis agent should call the model again")
    const s2: any = JSON.parse(readFileSync(join(runsRoot, rid, "state.json"), "utf8"))
    const replayed = Object.values(s2.agents).filter((a: any) => a.replayed).length
    assert.equal(replayed, 3, "3 agents replayed")
    assert.equal(s2.agentCount, 4)
    assert.equal(s2.resumeCount, 1)
    assert.equal(s2.startedAt, s1.startedAt, "original start time kept")
    assert.ok(s2.logs.some((l: any) => /paused|stopped|exited/.test(l.message)), "prior logs carried over")
    assert.ok(s2.logs.some((l: any) => /^resumed \(3 completed agents replay/.test(l.message)), "resume log line")
    const final = JSON.parse(r2.result!)
    assert.equal(final.tips.length, 3, "replayed results feed the rest of the script")
    assert.ok(!s2.error, "error cleared on successful resume")
    console.log(`  ok: resume replayed ${replayed} agents, re-ran 1, completed`)
  }

  // ---- test 6: a failed agent holds the script; retry continues in its session --
  console.log("test 6: failed agent waits for a decision — R retries in the same session with the note, X skips")
  {
    const SCHEMA_SCRIPT = `
export const meta = { name: "t6", description: "hold", phases: [{ title: "A" }] }
phase("A")
const out = await parallel([
  () => agent("FAILME first task", { label: "flaky", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }),
  () => agent("FAILME second task", { label: "hopeless", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }),
])
log("out:" + JSON.stringify(out))
return out
`
    const prompts: Array<{ session: string; text: string }> = []
    let seq = 0
    const client = {
      session: {
        async create() {
          return { id: `ses_t6_${++seq}` }
        },
        async prompt(args: any) {
          const text = String(args.body?.parts?.[0]?.text ?? "")
          prompts.push({ session: args.path.id, text })
          // only a follow-up carrying the user's note is answered correctly
          const good = /Note from the user: please just answer/.test(text)
          return { info: assistantMsg(args.path.id), parts: [{ type: "text", text: good ? '{"ok":true}' : "sorry, no json here" }] }
        },
        async abort() {
          return true
        },
      },
    }
    const rid = generateRunId()
    const engine = new RunEngine({ client: client as any, opencodeDir, runsRoot, mainSessionID: "ses_main", availableModels: new Set() }, rid)
    const done = engine.run({ script: SCHEMA_SCRIPT })
    const stateOf = () => JSON.parse(readFileSync(join(runsRoot, rid, "state.json"), "utf8"))
    const waitFor = async (pred: (s: any) => boolean, what: string) => {
      for (let i = 0; i < 100; i++) {
        engine.flushNow()
        const s = stateOf()
        if (pred(s)) return s
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error(`timed out waiting for: ${what}`)
    }
    const s1 = await waitFor((s) => Object.values(s.agents).filter((a: any) => a.held).length === 2, "both agents held")
    const flaky = Object.values(s1.agents).find((a: any) => a.label === "flaky") as any
    const hopeless = Object.values(s1.agents).find((a: any) => a.label === "hopeless") as any
    assert.equal(flaky.status, "failed")
    assert.equal(flaky.attempts, 2, "two automatic attempts before holding")
    assert.ok(/not valid JSON/.test(flaky.error), flaky.error)
    assert.equal(s1.status, "running", "run keeps running while agents are held")
    assert.equal(s1.agentDone, 0, "held agents do not count as done")
    // both automatic attempts went to the same session; the second was a follow-up (no TASK repeated)
    const flakyPrompts = prompts.filter((p) => p.session === flaky.sessionId)
    assert.equal(flakyPrompts.length, 2)
    assert.ok(/--- TASK ---/.test(flakyPrompts[0].text) && !/--- TASK ---/.test(flakyPrompts[1].text), "automatic retry is a follow-up in the same session")
    assert.ok(/Your previous attempt did not go through — previous response was not valid JSON/.test(flakyPrompts[1].text), "the follow-up carries the error")

    // R with a note on the first, X on the second (what the TUI writes to control.json)
    writeFileSync(join(runsRoot, rid, "control.json"), JSON.stringify({ action: "retry", agentId: flaky.id, note: "please just answer", at: 1 }))
    await waitFor((s) => s.agents[flaky.id].status === "completed", "flaky completed after retry")
    writeFileSync(join(runsRoot, rid, "control.json"), JSON.stringify({ action: "stop", agentId: hopeless.id, at: 1 }))
    const r6 = await done
    assert.equal(r6.status, "completed", `run should complete, error=${r6.error}`)
    const s2 = stateOf()
    assert.equal(s2.agents[flaky.id].attempts, 3)
    assert.equal(s2.agents[flaky.id].retryNote, "please just answer")
    assert.equal(s2.agents[flaky.id].held, false)
    assert.deepEqual(s2.agents[flaky.id].outcome, { ok: true })
    assert.equal(s2.agents[hopeless.id].status, "failed", "skipped agent keeps its failure")
    assert.equal(s2.agents[hopeless.id].held, false)
    const retryPrompt = prompts.filter((p) => p.session === flaky.sessionId)[2].text
    assert.ok(/Note from the user: please just answer/.test(retryPrompt) && /not valid JSON/.test(retryPrompt) && !/--- TASK ---/.test(retryPrompt), "user retry = same session, error + note, no task repeat")
    assert.equal(prompts.filter((p) => p.session === flaky.sessionId).length, 3, "three prompts, one session")
    assert.equal(seq, 2, "no new sessions were created")
    assert.ok(s2.logs.some((l: any) => l.message === "out:[{\"ok\":true},null]"), "script saw the retried result and null for the skipped one")
    console.log("  ok: hold → retry with note (same session) → completed; hold → skip → null")
  }

  // ---- test 7: pause / resume one agent while it runs ---------------------------
  console.log("test 7: P pauses one running agent (session kept), P again resumes it in the same session")
  {
    const S7 = `
export const meta = { name: "t7", description: "pause one agent", phases: [{ title: "A" }] }
phase("A")
const [slow, fast] = await parallel([() => agent("slow task", { label: "slow" }), () => agent("fast task", { label: "fast" })])
return { slow, fast }
`
    let seq = 0
    const prompts: Array<{ session: string; text: string }> = []
    let releaseSlow: ((v: any) => void) | undefined
    const client = {
      session: {
        async create(args: any) {
          return { id: `ses_t7_${++seq}_${String(args.body?.title).split("/").pop()}` }
        },
        prompt(args: any) {
          const text = String(args.body?.parts?.[0]?.text ?? "")
          prompts.push({ session: args.path.id, text })
          if (/_slow$/.test(args.path.id) && !/follow-up/.test(text)) {
            // first prompt of the slow agent: generation runs until abort()
            return new Promise((res) => {
              releaseSlow = res
            })
          }
          return Promise.resolve({ info: assistantMsg(args.path.id), parts: [{ type: "text", text: `done ${args.path.id}` }] })
        },
        async abort(args: any) {
          // opencode answers the pending prompt with an aborted message
          releaseSlow?.({ info: { ...assistantMsg(args.path.id), error: { name: "MessageAbortedError", data: { message: "aborted" } } }, parts: [] })
          releaseSlow = undefined
          return true
        },
      },
    }
    const rid = generateRunId()
    const engine = new RunEngine({ client: client as any, opencodeDir, runsRoot, mainSessionID: "ses_main", availableModels: new Set() }, rid)
    const done = engine.run({ script: S7 })
    const stateOf = () => JSON.parse(readFileSync(join(runsRoot, rid, "state.json"), "utf8"))
    const waitFor = async (pred: (s: any) => boolean, what: string) => {
      for (let i = 0; i < 100; i++) {
        engine.flushNow()
        const s = stateOf()
        if (pred(s)) return s
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error(`timed out waiting for: ${what}`)
    }
    const s1 = await waitFor((s) => Object.values(s.agents).some((a: any) => a.label === "fast" && a.status === "completed") && Object.values(s.agents).some((a: any) => a.label === "slow" && a.status === "running"), "fast done, slow running")
    const slow = Object.values(s1.agents).find((a: any) => a.label === "slow") as any
    writeFileSync(join(runsRoot, rid, "control.json"), JSON.stringify({ action: "pause", agentId: slow.id, at: 1 }))
    await waitFor((s) => s.agents[slow.id].status === "paused" && s.agents[slow.id].held === true, "slow paused")
    assert.equal(stateOf().status, "running", "only the agent is paused, not the run")
    writeFileSync(join(runsRoot, rid, "control.json"), JSON.stringify({ action: "resume", agentId: slow.id, at: 1 }))
    const r7 = await done
    assert.equal(r7.status, "completed", `run should complete, error=${r7.error}`)
    const s2 = stateOf()
    assert.equal(s2.agents[slow.id].status, "completed")
    assert.equal(s2.agents[slow.id].attempts, 2)
    const slowPrompts = prompts.filter((p) => p.session === slow.sessionId)
    assert.equal(slowPrompts.length, 2, "resume = one follow-up prompt in the same session")
    assert.ok(/you were paused by the user/.test(slowPrompts[1].text), slowPrompts[1].text)
    assert.equal(JSON.parse(r7.result!).slow, `done ${slow.sessionId}`)
    console.log("  ok: pause kept the session, resume continued it, run completed")
  }

  // ---- test 8: resume of a dead run continues failed agents in their session, with a note --
  console.log("test 8: resume with retryNotes — the failed agent continues its old session with the note")
  {
    const S8 = `
export const meta = { name: "t8", description: "resume note", phases: [{ title: "A" }] }
phase("A")
const r = await agent("FAILME research", { label: "res", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } })
return r
`
    const prompts: Array<{ session: string; text: string }> = []
    let seq = 0
    let sessionGone = false
    const client = {
      session: {
        async create() {
          return { id: `ses_t8_${++seq}` }
        },
        async prompt(args: any) {
          const text = String(args.body?.parts?.[0]?.text ?? "")
          prompts.push({ session: args.path.id, text })
          const good = /Note from the user: use the cached data/.test(text)
          return { info: assistantMsg(args.path.id), parts: [{ type: "text", text: good ? '{"ok":true}' : "nope" }] }
        },
        async abort() {
          return true
        },
        async get(args: any) {
          if (sessionGone) return { data: undefined, error: { data: { message: "not found" } } }
          return { data: { id: args.path.id }, error: undefined }
        },
      },
    }
    const deps = { client: client as any, opencodeDir, runsRoot, mainSessionID: "ses_main", availableModels: new Set<string>() }
    // first run: the agent fails and nobody decides; the engine dies (shutdown)
    const rid = generateRunId()
    const e1 = new RunEngine(deps, rid)
    const p1 = e1.run({ script: S8 })
    for (let i = 0; i < 100; i++) {
      e1.flushNow()
      const s = JSON.parse(readFileSync(join(runsRoot, rid, "state.json"), "utf8"))
      if (Object.values(s.agents).some((a: any) => a.held)) break
      await new Promise((r) => setTimeout(r, 50))
    }
    e1.shutdown("opencode exited")
    const r1 = await p1
    assert.equal(r1.status, "stopped")
    const s1: any = JSON.parse(readFileSync(join(runsRoot, rid, "state.json"), "utf8"))
    const agentId = s1.agentOrder[0]
    assert.equal(s1.agents[agentId].status, "failed")
    assert.equal(s1.agents[agentId].held, false)
    assert.ok(s1.agents[agentId].sessionId)

    // resume with a note for that agent → same session, note in the follow-up
    const prior = loadPriorRun(runsRoot, rid)!
    assert.equal(prior.replayable, 0)
    assert.equal([...prior.continuable.values()].flat().length, 1)
    const before = prompts.length
    const e2 = new RunEngine(deps, rid)
    const r2 = await e2.run({ resume: prior, retryNotes: { [agentId]: "use the cached data" } })
    assert.equal(r2.status, "completed", `resumed run should complete, error=${r2.error}`)
    assert.equal(prompts.length - before, 1)
    const p = prompts[prompts.length - 1]
    assert.equal(p.session, s1.agents[agentId].sessionId, "continued in the earlier session")
    assert.ok(/Note from the user: use the cached data/.test(p.text) && /not valid JSON/.test(p.text) && !/--- TASK ---/.test(p.text), p.text)
    const s2: any = JSON.parse(readFileSync(join(runsRoot, rid, "state.json"), "utf8"))
    const a2 = s2.agents[s2.agentOrder[0]]
    assert.equal(a2.continued, true)
    assert.equal(a2.attempts, 3, "attempt count carries over (2 before, 1 now)")
    assert.ok(a2.tokens > s1.agents[agentId].tokens, "billed tokens carry over and grow")
    assert.equal(seq, 1, "no new session")
    assert.equal(JSON.parse(r2.result!).ok, true)

    // the same resume when the session no longer exists → fresh session, note still delivered
    sessionGone = true
    const rid2 = generateRunId()
    const e3 = new RunEngine(deps, rid2)
    const p3 = e3.run({ script: S8 })
    for (let i = 0; i < 100; i++) {
      e3.flushNow()
      const s = JSON.parse(readFileSync(join(runsRoot, rid2, "state.json"), "utf8"))
      if (Object.values(s.agents).some((a: any) => a.held)) break
      await new Promise((r) => setTimeout(r, 50))
    }
    e3.shutdown("opencode exited")
    await p3
    const prior2 = loadPriorRun(runsRoot, rid2)!
    const id2 = prior2.state.agentOrder[0]
    const seqBefore = seq
    const e4 = new RunEngine(deps, rid2)
    const r4 = await e4.run({ resume: prior2, retryNotes: { [id2]: "use the cached data" } })
    assert.equal(r4.status, "completed", r4.error)
    assert.equal(seq, seqBefore + 1, "a fresh session was created")
    const last = prompts[prompts.length - 1].text
    assert.ok(/--- TASK ---/.test(last) && /Note from the user: use the cached data/.test(last), "fresh session gets the full task plus the note")
    console.log("  ok: resume continued the old session with the note; fell back to a fresh session when it was gone")
  }

  // ---- test 9: ULTRACODE_HOLD_FAILED=0 → old behaviour (null right away) --------
  console.log("test 9: ULTRACODE_HOLD_FAILED=0 hands null to the script immediately")
  {
    process.env.ULTRACODE_HOLD_FAILED = "0"
    try {
      const S9 = `
export const meta = { name: "t9", description: "no hold", phases: [{ title: "A" }] }
phase("A")
const r = await agent("FAILME", { label: "x", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } })
return { r }
`
      const client = {
        session: {
          async create() {
            return { id: "ses_t9" }
          },
          async prompt(args: any) {
            return { info: assistantMsg(args.path.id), parts: [{ type: "text", text: "nope" }] }
          },
          async abort() {
            return true
          },
        },
      }
      const rid = generateRunId()
      const e = new RunEngine({ client: client as any, opencodeDir, runsRoot, mainSessionID: "ses_main", availableModels: new Set() }, rid)
      const r = await e.run({ script: S9 })
      assert.equal(r.status, "completed")
      assert.deepEqual(JSON.parse(r.result!), { r: null })
      const s: any = JSON.parse(readFileSync(join(runsRoot, rid, "state.json"), "utf8"))
      assert.equal(s.agents[s.agentOrder[0]].status, "failed")
      assert.equal(s.agentDone, 1)
      console.log("  ok: no hold, null delivered")
    } finally {
      delete process.env.ULTRACODE_HOLD_FAILED
    }
  }

console.log(`\nALL TESTS PASSED (${Date.now() - t0}ms total, tmp=${tmp})`)
}

main().catch((e) => {
  console.error("\nSELFTEST FAILED:", e)
  process.exit(1)
})
