const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const {
  EthereumRoundTripScenario: Scenario,
  EthereumSyndicationTool,
  ClusterBuild,
  OutputStore
} = require("@wireio/cluster-tool")
const { EthereumHappyScenario } = require("../lib/EthereumHappyScenario.js")
const StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js")
afterEach(() => mock.restoreAll())
function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}
for (const [name, balance, expected] of [
  ["no shadow", [], 0n],
  ["exact shadow", [{ balance: "1.000000000 LIQETH" }], Scenario.Amount]
])
  test(name, async () => {
    const ctx = {
      wire: {
        getSysioContract: () => ({
          tables: {
            accounts: { query: async () => ({ rows: balance, more: false }) }
          }
        })
      }
    }
    Assert.equal(await Scenario.shadowBalance(ctx), expected)
  })
test("refuse a truncated holder read", async () => {
  const ctx = {
    wire: {
      getSysioContract: () => ({
        tables: { accounts: { query: async () => ({ rows: [], more: true }) } }
      })
    }
  }
  await Assert.rejects(Scenario.shadowBalance(ctx), /truncated/)
})
for (const paid of [Scenario.Wei, Scenario.Wei - 1n, Scenario.Wei + 1n])
  test(`final recipient must hold exact payout ${paid}`, async () => {
    const ctx = { outputs: new OutputStore() },
      build = ClusterBuild.forContext(ctx)
    new EthereumHappyScenario().plan(build)
    const step = steps(build).find(
      step => step.name === "ethereum-paid-exactly"
    )
    Assert.ok(step)
    mock.method(Scenario, "externalBalance", async () => paid)
    mock.method(Scenario, "readInboundEpoch", async () => 1n)
    mock.method(StepTools, "pollUntil", async (_label, predicate) =>
      Assert.ok(await predicate(), "payout incomplete or duplicate")
    )
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (paid === Scenario.Wei) await run()
    else await Assert.rejects(run, /incomplete or duplicate/)
  })
test("happy journey includes real custody, governance release, full burn and final solvency", () => {
  const build = ClusterBuild.forContext({ outputs: new OutputStore() })
  new EthereumHappyScenario().plan(build)
  const names = steps(build).map(step => step.name)
  for (const name of [
    "deposit-eth",
    "approve-pool",
    "syndicate-liqeth",
    "validate-intake",
    "link-ethereum-holder",
    "ethereum-shadow-delivered",
    "redeem-liqeth",
    "ethereum-paid-exactly",
    "settlement-stays-exact",
    "solvent-after-round-trip"
  ])
    Assert.ok(names.includes(name), name)
})
for (const advanced of [true, false])
  test(`post-payout requires actual destination inbound progress: ${advanced}`, async () => {
    const ctx = { outputs: new OutputStore() },
      build = ClusterBuild.forContext(ctx)
    new EthereumHappyScenario().plan(build)
    ctx.outputs.set(Scenario.SettledEpoch, 5n)
    ctx.outputs.set(Scenario.PoolBefore, 0n)
    const step = steps(build).find(
      step => step.name === "settlement-stays-exact"
    )
    mock.method(Scenario, "readInboundEpoch", async () => (advanced ? 6n : 5n))
    mock.method(Scenario, "externalBalance", async () => Scenario.Wei)
    mock.method(Scenario, "shadowBalance", async () => 0n)
    mock.method(EthereumSyndicationTool, "readPoolBalanceDepot", async () => 0n)
    mock.method(StepTools, "pollUntil", async (_label, predicate) =>
      Assert.ok(await predicate(), "destination inbound stalled")
    )
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (advanced) await run()
    else await Assert.rejects(run, /destination inbound stalled/)
  })
