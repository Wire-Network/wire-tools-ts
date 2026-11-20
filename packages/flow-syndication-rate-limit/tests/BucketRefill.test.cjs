const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { ClusterBuild, OutputStore, SyndicationScenario, WireSyndicationTool } = require("@wireio/cluster-tool")
const { SyndicationRateLimitScenario } = require("../lib/SyndicationRateLimitScenario.js")
const { SyndicationRateLimitScenarioConstants: Constants } = require("../lib/SyndicationRateLimitScenarioConstants.js")

afterEach(() => mock.restoreAll())

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

/** A bucket tick `seconds` past a fixed origin, as the contract's `time_point_sec`. */
function tickAt(seconds) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString().slice(0, 19)
}

for (const fault of ["none", "short-refill", "over-capacity", "time-regression"]) {
  test(`native bucket accounts for elapsed seconds and caps refill: ${fault}`, async () => {
    const ctx = { outputs: new OutputStore(), config: { dataPath: "/tmp/unused-unit-wallet" } }
    const build = ClusterBuild.forContext(ctx)
    new SyndicationRateLimitScenario().plan(build)
    const step = steps(build).find(value => value.name === "burst-drained")
    Assert.ok(step)
    ctx.outputs.set(Constants.RefillBucket, { level: "0", last_refill: tickAt(2) })
    ctx.outputs.set(Constants.RefillReleased, Constants.Burst + Constants.Overflow)
    ctx.outputs.set(Constants.Epoch, 1)
    mock.method(SyndicationScenario, "readBalance", async (_ctx, account) =>
      account === Constants.UserA.account ? Constants.AmountA : Constants.AmountB)
    mock.method(SyndicationScenario, "readEnvelope", async () => ({ released: String(Constants.Burst * 2n) }))
    // Twice the full-refill time saturates capacity at one burst. The remaining release is 3/4 burst.
    const level = fault === "short-refill" ? Constants.Overflow - 1n
      : fault === "over-capacity" ? Constants.Overflow + 1n : Constants.Overflow
    mock.method(WireSyndicationTool, "readBucket", async () => ({
      level: String(level),
      last_refill: fault === "time-regression" ? tickAt(1) : tickAt(2 + 2 * Constants.FullRefillSec)
    }))
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (fault === "none") await run()
    else await Assert.rejects(run)
  })
}

// 40 s refills past A's overflow, so B receives the rest.
for (const elapsed of [0, 1, 40])
  test(`partial refill releases exactly R per elapsed second in arrival order: ${elapsed}s`, async () => {
    const ctx = { outputs: new OutputStore(), config: { dataPath: "/tmp/unused-unit-wallet" } }
    const build = ClusterBuild.forContext(ctx)
    new SyndicationRateLimitScenario().plan(build)
    const step = steps(build).find(value => value.name === "refill-exact")
    Assert.ok(step)
    const released = Constants.Refill * BigInt(elapsed),
      toA = released < Constants.Overflow ? released : Constants.Overflow
    ctx.outputs.set(Constants.FirstBucket, { level: "0", last_refill: tickAt(5) })
    ctx.outputs.set(Constants.Epoch, 1)
    mock.method(SyndicationScenario, "readBalance", async (_ctx, account) =>
      account === Constants.UserA.account ? Constants.Burst + toA : released - toA)
    mock.method(SyndicationScenario, "readEnvelope", async () => ({ released: String(Constants.Burst + released) }))
    mock.method(WireSyndicationTool, "readBucket", async () => ({ level: "0", last_refill: tickAt(5 + elapsed) }))
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    // A crank in the first bucket tick's second refills nothing, which the step refuses as no refill at all.
    if (elapsed === 0) await Assert.rejects(run)
    else {
      await run()
      Assert.equal(ctx.outputs.assert(Constants.RefillReleased), Constants.Burst + released)
    }
  })
