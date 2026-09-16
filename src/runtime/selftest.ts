// Standalone engine test: runs workflow scripts against a mocked opencode client.
// Usage: node src/runtime/selftest.ts

import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert"
import { generateRunId, RunEngine } from "./engine.ts"
import { parseScript } from "./script.ts"

const tmp = mkdtempSync(join(tmpdir(), "wf-selftest-"))
const opencodeDir = join(tmp, ".opencode")

let sessionSeq = 0
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
    { client: fakeClient as any, opencodeDir, mainSessionID: "ses_main", defaultModel: "mock/sonnet", availableModels: new Set(["mock/sonnet", "mock/haiku"]), runArgs: { extra: 1 } },
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
  const state = JSON.parse(readFileSync(join(opencodeDir, "workflows", "runs", runId, "state.json"), "utf8"))
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
  assert.ok(synth.outcome, "outcome stored")
  assert.ok(state.totalTokens > 0)
  console.log(`  ok: state.json (4 agents, 2 phases, tokens=${state.totalTokens})`)

  // journal
  const journal = readFileSync(join(opencodeDir, "workflows", "runs", runId, "journal.jsonl"), "utf8").trim().split("\n")
  assert.ok(journal.length >= 9, `journal lines = ${journal.length}`)
  const kinds = journal.map((l) => JSON.parse(l).type)
  assert.ok(kinds.includes("run-start") && kinds.includes("run-end"))
  assert.equal(kinds.filter((k: string) => k === "agent-start").length, 4)
  assert.equal(kinds.filter((k: string) => k === "agent-done").length, 4)
  console.log("  ok: journal (run-start, 4x agent-start/done, run-end)")

  // script.js persisted
  assert.ok(existsSync(join(opencodeDir, "workflows", "runs", runId, "script.js")), "script.js persisted")
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
  const e3 = new RunEngine({ client: fakeClient as any, opencodeDir, mainSessionID: "ses_main", availableModels: new Set() }, rid3)
  const r3 = await e3.run({ script: S1 })
  assert.equal(r3.status, "completed")
  const s3 = JSON.parse(readFileSync(join(opencodeDir, "workflows", "runs", rid3, "state.json"), "utf8"))
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
  const e3b = new RunEngine({ client: fakeClient as any, opencodeDir, mainSessionID: "ses_main", availableModels: new Set() }, rid3b)
  const r3b = await e3b.run({ script: S2 })
  assert.equal(r3b.status, "completed")
  const s3b = JSON.parse(readFileSync(join(opencodeDir, "workflows", "runs", rid3b, "state.json"), "utf8"))
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
  const e4 = new RunEngine({ client: fakeClient as any, opencodeDir, mainSessionID: "ses_main", availableModels: new Set() }, rid4)
  const r4 = await e4.run({ script: S4 })
  assert.equal(r4.status, "completed")
  const s4 = JSON.parse(readFileSync(join(opencodeDir, "workflows", "runs", rid4, "state.json"), "utf8"))
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

  console.log(`\nALL TESTS PASSED (${Date.now() - t0}ms total, tmp=${tmp})`)
}

main().catch((e) => {
  console.error("\nSELFTEST FAILED:", e)
  process.exit(1)
})
