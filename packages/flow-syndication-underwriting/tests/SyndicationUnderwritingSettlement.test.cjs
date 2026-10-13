const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const {
  ClusterBuild,
  OutputStore,
  SyndicationScenario
} = require("@wireio/cluster-tool")
const { SysioContracts } = require("@wireio/sdk-core")
const {
  SyndicationUnderwritingScenario
} = require("../lib/SyndicationUnderwritingScenario.js")
const {
  SyndicationUnderwritingScenarioConstants: Constants
} = require("../lib/SyndicationUnderwritingScenarioConstants.js")
afterEach(() => mock.restoreAll())

/** Flatten the planned flow so tests exercise the actual verification runner. */
function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

// Per-envelope accounting replaces historical totals without losing exact-amount coverage.
for (const fault of ["none", "first", "second", "wallet", "fees"]) {
  test(`underwriting release checks both envelope amounts and actual credit: ${fault}`, async () => {
    const ctx = {
        outputs: new OutputStore(),
        config: { dataPath: "/tmp/unused-unit-wallet" }
      },
      build = ClusterBuild.forContext(ctx),
      fee =
        (Constants.Amount * BigInt(Constants.FeeBps)) /
        SyndicationScenario.BasisPoints
    new SyndicationUnderwritingScenario().plan(build)
    ctx.outputs.set(Constants.Before, { holder: 0n, bonder: 0n, fees: 0n })
    mock.method(SyndicationScenario, "readEnvelope", async (_ctx, key) =>
      key === Constants.FirstEpoch
        ? {
            released: Constants.Amount.toString(),
            synd_total: (
              Constants.Amount + (fault === "first" ? 1n : 0n)
            ).toString()
          }
        : {
            synd_total: (
              Constants.LaterAmount + (fault === "second" ? 1n : 0n)
            ).toString(),
            state: SysioContracts.SysioSyndEnvelopeState.REQUESTED,
            request_id: 2
          }
    )
    mock.method(
      SyndicationScenario,
      "readBalance",
      async () => Constants.Amount - fee - (fault === "wallet" ? 1n : 0n)
    )
    mock.method(
      SyndicationScenario,
      "readFees",
      async () => fee + (fault === "fees" ? 1n : 0n)
    )
    const step = steps(build).find(
      value => value.name === "first-released-next-requested"
    )
    Assert.ok(step)
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (fault === "none") await run()
    else await Assert.rejects(run)
  })
}
