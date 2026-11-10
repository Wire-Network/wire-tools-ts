const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const {
  EthereumRoundTripScenario: Scenario,
  EthereumSyndicationTool,
  WireSyndicationTool,
  ClusterBuild,
  OutputStore
} = require("@wireio/cluster-tool")
const { EthereumHappyScenario } = require("../lib/EthereumHappyScenario.js")
const StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js")
afterEach(() => mock.restoreAll())
const Fee = 5_500_000n
const NetWei = (Scenario.Amount - Fee) * Scenario.WeiPerDepotUnit
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
for (const paid of [NetWei, NetWei - 1n, NetWei + 1n, Scenario.Wei])
  test(`final recipient must hold exact payout ${paid}`, async () => {
    const ctx = { outputs: new OutputStore() },
      build = ClusterBuild.forContext(ctx)
    new EthereumHappyScenario().plan(build)
    ctx.outputs.set(Scenario.RedemptionFee, Fee)
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
    if (paid === NetWei) await run()
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
    "quote-redemption-fee",
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
    ctx.outputs.set(Scenario.RedemptionFee, Fee)
    const step = steps(build).find(
      step => step.name === "settlement-stays-exact"
    )
    mock.method(Scenario, "readInboundEpoch", async () => (advanced ? 6n : 5n))
    mock.method(Scenario, "externalBalance", async () => NetWei)
    mock.method(Scenario, "shadowBalance", async () => 0n)
    mock.method(EthereumSyndicationTool, "readPoolBalanceDepot", async () => Fee)
    mock.method(StepTools, "pollUntil", async (_label, predicate) =>
      Assert.ok(await predicate(), "destination inbound stalled")
    )
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (advanced) await run()
    else await Assert.rejects(run, /destination inbound stalled/)
  })
test("the quote step stores the live fee on the full principal", async () => {
  const ctx = { outputs: new OutputStore() },
    build = ClusterBuild.forContext(ctx)
  new EthereumHappyScenario().plan(build)
  const step = steps(build).find(step => step.name === "quote-redemption-fee")
  mock.method(WireSyndicationTool, "readDesyndicationFee", async (_ctx, quantity) => {
    Assert.equal(quantity, Scenario.Quantity)
    return Fee.toString()
  })
  await step.runner(ctx, step.input, new AbortController().signal)
  Assert.equal(ctx.outputs.assert(Scenario.RedemptionFee), Fee)
  Assert.equal(Scenario.netWei(ctx), NetWei)
})
for (const [outstanding, ok] of [
  [Fee, true],
  [0n, false]
])
  test(`the burn keeps only the fee outstanding: ${outstanding}`, async () => {
    const ctx = { outputs: new OutputStore() },
      build = ClusterBuild.forContext(ctx)
    new EthereumHappyScenario().plan(build)
    ctx.outputs.set(Scenario.OutstandingBefore, 0n)
    ctx.outputs.set(Scenario.RedemptionFee, Fee)
    const step = steps(build).find(step => step.name === "shadow-burned")
    mock.method(Scenario, "shadowBalance", async () => 0n)
    mock.method(WireSyndicationTool, "readOutstanding", async () => outstanding)
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (ok) await run()
    else await Assert.rejects(run)
  })
