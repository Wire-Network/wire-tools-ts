const Assert = require("node:assert/strict")
const { ClusterBuild, Constants, OutputStore, Steps, WireSyndicationTool } = require("@wireio/cluster-tool")
const { LIQYieldScenario } = require("../lib/LIQYieldScenario.js")
const { LIQYieldScenarioConstants } = require("../lib/LIQYieldScenarioConstants.js")

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

// The flow waits for the reservoir to empty, and the operators tick each pool about once a
// minute: one clip at the mock pool's cap has to sell the whole reported yield, which is the
// donation plus whatever staking yield accrued, so the cap must clear the donation with room.
test("one clip at the mock LIQSOL pool's cap sells more than the donated yield", () => {
  const pool = Steps.registry.MockLiqPoolRegistrations.find(row => row.token_code === Constants.LIQSOL_CODENAME),
    clip = BigInt(pool.initial_chain_amount) * BigInt(pool.depth_cap_bps) / WireSyndicationTool.BasisPoints
  Assert.ok(pool.depth_cap_bps <= pool.fee)
  Assert.ok(clip > LIQYieldScenarioConstants.BonusYieldLamports,
    `a clip of ${clip} does not clear the ${LIQYieldScenarioConstants.BonusYieldLamports} donated`)
})
