export const meta = {
  name: "demo-fanout",
  description: "Demo: 3 agents write tips on multi-agent workflows, 1 agent synthesizes",
  whenToUse: "Showcase of the workflow engine — fan out 3 tip writers, then 1 synthesizer",
  phases: [
    { title: "Generate", detail: "3 agents, one tip each" },
    { title: "Synthesize", detail: "merge the tips into the final set" },
  ],
}

const ANGLES = ["design", "execution", "debugging"]

phase("Generate")
const results = await parallel(
  ANGLES.map((a) => () =>
    agent(
      `Write one concise tip (2-3 sentences) about ${a.toUpperCase()} multi-agent workflows: concurrency limits, token budget, and worktree isolation.`,
      {
        label: `tip:${a}`,
        schema: {
          type: "object",
          properties: {
            angle: { type: "string", description: "The angle this tip covers" },
            tip: { type: "string", description: "The tip itself, 2-3 sentences" },
          },
          required: ["angle", "tip"],
        },
      }
    )
  )
)
const tips = results.filter(Boolean)
log(`${tips.length}/${ANGLES.length} tips generated`)

phase("Synthesize")
const final = await agent(
  `Synthesize the following tips about multi-agent workflows into the single best set (keep at most 3, merge overlaps). Return JSON.

Tips:
${JSON.stringify(tips, null, 2)}`,
  {
    label: "tip:synthesis",
    schema: {
      type: "object",
      properties: {
        report: {
          type: "object",
          properties: {
            count: { type: "number" },
            best: { type: "array", items: { type: "string" } },
          },
          required: ["count", "best"],
        },
      },
      required: ["report"],
    },
  }
)
return { tips, final }
