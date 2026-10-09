const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { ClusterBuild, OutputStore, SyndicationScenario, WireSyndicationTool } = require("@wireio/cluster-tool")
const { SyndicationRateLimitScenario } = require("../lib/SyndicationRateLimitScenario.js")
const { SyndicationRateLimitScenarioConstants: Constants } = require("../lib/SyndicationRateLimitScenarioConstants.js")

afterEach(() => mock.restoreAll())

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

for (const fault of ["none", "short-refill", "over-capacity", "epoch-regression"]) {
  test(`native bucket accounts for elapsed epochs and caps refill: ${fault}`, async () => {
    const ctx = { outputs: new OutputStore(), config: { dataPath: "/tmp/unused-unit-wallet" } }
    const build = ClusterBuild.forContext(ctx)
    new SyndicationRateLimitScenario().plan(build)
    const step = steps(build).find(value => value.name === "burst-drained")
    Assert.ok(step)
    ctx.outputs.set(Constants.RefillBucket, { level: "0", last_epoch: 2 })
    ctx.outputs.set(Constants.RefillReleased, Constants.Burst + Constants.Refill)
    ctx.outputs.set(Constants.Epoch, 1)
    mock.method(SyndicationScenario, "readBalance", async (_ctx, account) =>
      account === Constants.UserA.account ? Constants.AmountA : Constants.AmountB)
    mock.method(SyndicationScenario, "readEnvelope", async () => ({ released: String(Constants.Burst * 2n) }))
    // Ten elapsed epochs saturate capacity at one burst. The remaining release is 3/4 burst.
    const level = fault === "short-refill" ? Constants.Refill - 1n
      : fault === "over-capacity" ? Constants.Refill + 1n : Constants.Refill
    mock.method(WireSyndicationTool, "readBucket", async () => ({
      level: String(level), last_epoch: fault === "epoch-regression" ? 1 : 12
    }))
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (fault === "none") await run()
    else await Assert.rejects(run)
  })
}
