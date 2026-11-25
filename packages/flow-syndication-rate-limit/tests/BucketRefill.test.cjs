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

test("the intake leaves every refill crank work it cannot release in one burst", () => {
  const afterFirstBurst = Constants.Intake - Constants.Burst
  // The refill crank releases at most one burst, so work always remains for the final crank.
  Assert.ok(afterFirstBurst > Constants.Burst)
  // It releases at least one second of refill, so a full bucket later drains the rest.
  Assert.ok(afterFirstBurst - Constants.Refill <= Constants.Burst)
})

// The partial refill released A's overflow (25 s); the final crank releases the rest.
const RefillReleased = Constants.Burst + Constants.Overflow,
  FinalTranche = Constants.Intake - RefillReleased

for (const fault of ["none", "short-refill", "over-capacity", "time-regression", "unadvanced-tick", "no-tranche"]) {
  test(`final crank releases a positive tranche at a later tick within the refilled capacity: ${fault}`, async () => {
    const ctx = { outputs: new OutputStore(), config: { dataPath: "/tmp/unused-unit-wallet" } }
    const build = ClusterBuild.forContext(ctx)
    new SyndicationRateLimitScenario().plan(build)
    const step = steps(build).find(value => value.name === "burst-drained")
    Assert.ok(step)
    const previous = { level: "0", last_refill: tickAt(2) }
    ctx.outputs.set(Constants.RefillBucket, previous)
    // A refill crank that had drained the whole intake leaves the final crank nothing to release:
    // an unchanged bucket then matches its refill arithmetic, so only the tranche check refuses it.
    ctx.outputs.set(Constants.RefillReleased, fault === "no-tranche" ? Constants.Intake : RefillReleased)
    ctx.outputs.set(Constants.Epoch, 1)
    mock.method(SyndicationScenario, "readBalance", async (_ctx, account) =>
      account === Constants.UserA.account ? Constants.AmountA : Constants.AmountB)
    mock.method(SyndicationScenario, "readEnvelope", async () => ({ released: String(Constants.Intake) }))
    // Twice the full-refill time saturates capacity at one burst, less the final tranche.
    const level = Constants.Burst - FinalTranche,
      bucket = fault === "unadvanced-tick" || fault === "no-tranche" ? previous
        : {
          level: String(fault === "short-refill" ? level - 1n : fault === "over-capacity" ? level + 1n : level),
          last_refill: fault === "time-regression" ? tickAt(1) : tickAt(2 + 2 * Constants.FullRefillSec)
        }
    mock.method(WireSyndicationTool, "readBucket", async () => bucket)
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (fault === "none") await run()
    else if (fault === "no-tranche") await Assert.rejects(run, /positive tranche/)
    else if (fault === "unadvanced-tick") await Assert.rejects(run, /advance the bucket's last refill/)
    else await Assert.rejects(run)
  })
}

// 40 s refills past A's overflow, so B receives the rest; 150 s saturates at one burst and still
// leaves work behind.
for (const elapsed of [0, 1, 40, 150])
  test(`partial refill releases exactly R per elapsed second, capped at a burst, in arrival order: ${elapsed}s`, async () => {
    const ctx = { outputs: new OutputStore(), config: { dataPath: "/tmp/unused-unit-wallet" } }
    const build = ClusterBuild.forContext(ctx)
    new SyndicationRateLimitScenario().plan(build)
    const step = steps(build).find(value => value.name === "refill-exact")
    Assert.ok(step)
    const available = Constants.Refill * BigInt(elapsed),
      released = available < Constants.Burst ? available : Constants.Burst,
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
      Assert.ok(ctx.outputs.assert(Constants.RefillReleased) < Constants.Intake)
    }
  })
