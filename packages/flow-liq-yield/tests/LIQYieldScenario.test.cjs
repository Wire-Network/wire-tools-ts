const Assert = require("node:assert/strict")
const { ClusterBuild, OutputStore, Steps } = require("@wireio/cluster-tool")
const { LIQYieldScenario } = require("../lib/LIQYieldScenario.js")

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

for (const [balance, valid] of [["100.000000000 LIQSOL", true], ["100.000000001 LIQSOL", false]]) {
  test(`the imported shadow verification reads exact asset units: ${balance}`, async () => {
    const ctx = { outputs: new OutputStore(), wire: {
      getSysioContract: () => ({ tables: { accounts: { query: async () => ({ rows: [{ balance }] }) } } })
    } }, build = ClusterBuild.forContext(ctx),
      bonder = jest.spyOn(Steps.registry, "readMockSyndicationBonder").mockReturnValue({})
    try {
      new LIQYieldScenario().plan(build)
      const step = steps(build).find(step => step.name === "import-delivered-to-bonder"),
        run = () => step.runner(ctx, step.input, new AbortController().signal)
      if (valid) await run()
      else await Assert.rejects(run())
    } finally { bonder.mockRestore() }
  })
}
