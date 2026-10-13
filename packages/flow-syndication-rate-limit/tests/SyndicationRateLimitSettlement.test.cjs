const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const {
  ClusterBuild,
  OutputStore,
  SyndicationScenario,
  SolanaFundingTool,
  SolanaLiqSyndicationTool,
  WireSyndicationTool
} = require("@wireio/cluster-tool")
const StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js")
const {
  SyndicationRateLimitScenario
} = require("../lib/SyndicationRateLimitScenario.js")
const {
  SyndicationRateLimitScenarioConstants: Constants
} = require("../lib/SyndicationRateLimitScenarioConstants.js")
afterEach(() => mock.restoreAll())

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

for (const complete of [true, false])
  test(`settlement requires the complete destination balance: ${complete}`, async () => {
    const ctx = {
        outputs: new OutputStore(),
        config: { dataPath: "/tmp/unused-unit-wallet" }
      },
      build = ClusterBuild.forContext(ctx),
      baseline = 123456n,
      expected = baseline + Constants.DesyndicationAmount,
      balance = complete ? expected : expected - 1n
    new SyndicationRateLimitScenario().plan(build)
    const step = steps(build).find(value => value.name === "return-in-wallet")
    Assert.ok(step, "flow must contain its final wallet settlement assertion")
    mock.method(StepTools, "pollUntil", async (label, predicate) => {
      Assert.ok(await predicate(), "destination remains incomplete")
    })
    mock.method(
      SolanaLiqSyndicationTool,
      "readLiqsolBalance",
      async () => balance
    )

    ctx.outputs.set(Constants.ExternalBalanceBefore, baseline)

    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (complete) await run()
    else await Assert.rejects(run, /destination remains incomplete/)
  })

// Outstanding-return assertions must reject incorrect obligations even when the burn is correct.
for (const fault of [
  "none",
  "amount",
  "holder",
  "token",
  "balance",
  "supply"
]) {
  test(`queued redemption checks operational obligation and exact balances: ${fault}`, async () => {
    const before = {
        balance: Constants.DesyndicationAmount * 3n,
        supply: Constants.DesyndicationAmount * 8n,
        returns: 0
      },
      row = {
        amount: Constants.DesyndicationAmount.toString(),
        holder: Constants.UserA.account,
        token_code: SyndicationScenario.Token
      },
      ctx = {
        outputs: new OutputStore(),
        config: { dataPath: "/tmp/unused-unit-wallet" },
        wire: {
          getSysioContract: () => ({
            tables: {
              returns: { query: async () => ({ rows: [row], more: false }) }
            }
          })
        }
      },
      build = ClusterBuild.forContext(ctx)
    if (fault === "amount")
      row.amount = (Constants.DesyndicationAmount - 1n).toString()
    if (fault === "holder") row.holder = Constants.UserB.account
    if (fault === "token") row.token_code = "LIQETH"
    new SyndicationRateLimitScenario().plan(build)
    ctx.outputs.set(Constants.BeforeDesyndication, before)
    mock.method(
      SyndicationScenario,
      "readBalance",
      async () =>
        before.balance -
        Constants.DesyndicationAmount +
        (fault === "balance" ? 1n : 0n)
    )
    mock.method(WireSyndicationTool, "readShadowStat", async () => ({
      supply: SyndicationScenario.quantity(
        before.supply -
          Constants.DesyndicationAmount +
          (fault === "supply" ? 1n : 0n)
      )
    }))
    mock.method(WireSyndicationTool, "readBucket", async () => ({
      level: (
        Constants.DesyndicationBurst - Constants.DesyndicationAmount
      ).toString()
    }))
    const step = steps(build).find(
      value => value.name === "within-budget-queued"
    )
    Assert.ok(step)
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (fault === "none") await run()
    else await Assert.rejects(run)
  })
}
