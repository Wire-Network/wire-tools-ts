const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { ClusterBuild, OutputStore, Steps, EthereumSyndicationTool } = require("@wireio/cluster-tool")
const { EmergencyStopScenario } = require("../lib/EmergencyStopScenario.js")
const { EmergencyStopScenarioConstants: Constants } = require("../lib/EmergencyStopScenarioConstants.js")

afterEach(() => mock.restoreAll())

for (const lane of ["EthereumPause", "EthereumWithinAllowance", "EthereumShortfall"])
for (const fault of ["none", "later transaction", "wrong amount", "wrong depot amount", "wrong request", "wrong recipient", "pending remains"]) {
  test(`${lane} verifies receipt-backed settlement: ${fault}`, async () => {
    const ctx = { outputs: new OutputStore(), config: { dataPath: "/tmp/unused-unit-wallet" } },
      build = ClusterBuild.forContext(ctx),
      holder = "0x0000000000000000000000000000000000000001",
      paid = 123456n
    ctx.outputs.set(Constants.EthereumRequest, 7n)
    new EmergencyStopScenario().plan(build)
    const phase = build.children.find(value => value.name === lane)
    const step = phase.steps.find(value => value.name === "ethereum-paid")
    Assert.ok(step)
    mock.method(Steps.registry, "readMockSyndicationBonder", () => ({ ethereum: { address: holder } }))
    mock.method(EthereumSyndicationTool, "readDesyndicationPayment", async (_ctx, request) => {
      Assert.equal(request, 7n)
      return {
        recipient: fault === "wrong recipient" ? "0x0000000000000000000000000000000000000002" : holder,
        depotAmount: Constants.EthereumRedemption + (fault === "wrong depot amount" ? 1n : 0n),
        nativeAmount: Constants.EthereumRedemption * Constants.EthereumScale + (fault === "wrong amount" ? 1n : 0n),
        requestId: request + (fault === "wrong request" ? 1n : 0n), blockNumber: 120, transactionIndex: fault === "later transaction" ? 3 : 0
      }
    })
    mock.method(EthereumSyndicationTool, "readLiqEthBalance", async () => paid)
    mock.method(EthereumSyndicationTool, "readLiqEthRate", async () => { throw new Error("previous-block rate is not payment pre-state") })
    mock.method(EthereumSyndicationTool, "readPendingDesyndication", async () => fault === "pending remains" ? {} : null)
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (fault === "none" || fault === "later transaction") {
      await run()
      Assert.equal(ctx.outputs.assert(Constants.EthereumPaid), paid)
    } else await Assert.rejects(run)
  })
}
