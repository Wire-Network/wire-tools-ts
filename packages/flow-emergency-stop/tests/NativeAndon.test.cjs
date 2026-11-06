const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const { SysioContracts } = require("@wireio/sdk-core")
const { SyndicateLIQ } = require("@wireio/opp-typescript-models")
const {
  ClusterBuild, OutputStore, SyndicationScenario,
  SolanaLiqSyndicationTool, WireSyndicationTool
} = require("@wireio/cluster-tool")
const EnvelopeScan = require("@wireio/cluster-tool/lib/cjs/flow/oppEnvelopeScan.js")
const { EmergencyStopScenario } = require("../lib/EmergencyStopScenario.js")
const { EmergencyStopScenarioConstants: Constants } = require("../lib/EmergencyStopScenarioConstants.js")

afterEach(() => mock.restoreAll())

function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

for (const fault of ["none", "clear", "reason"]) {
  test(`manual pull requires native cord evidence: ${fault}`, async () => {
    const ctx = {
      outputs: new OutputStore(), config: { dataPath: "/tmp/unused-unit-wallet" },
      wire: { getSysioContract: () => ({ tables: {
        buckets: { query: async () => ({ rows: [], more: false }) },
        envlog: { query: async () => ({ rows: [], more: false }) }
      } }) }
    }
    const build = ClusterBuild.forContext(ctx)
    new EmergencyStopScenario().plan(build)
    const step = steps(build).find(value => value.name === "pull-snapshot")
    Assert.ok(step)
    mock.method(WireSyndicationTool, "readCord", async () => ({
      pulled: fault !== "clear", when: "2026-10-08T00:00:00",
      reason: fault === "reason" ? "unrelated incident" : "E7 deliberate emergency stop"
    }))
    mock.method(SyndicationScenario, "readEpoch", async () => 7)
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (fault === "none") await run()
    else await Assert.rejects(run)
  })
}

/** A pool custody change as `readSyndicationCustody` reports it. */
function custodyChange(signature, instructions, before, after, onlyYieldClaims = false) {
  return { signature, slot: 1, instructions, logs: [], before, after, onlyYieldClaims }
}

for (const fault of [
  "none", "clear", "missing-sequence", "wrong-sequence", "wrong-token",
  "syndication-snapshot", "foreign-custody-change", "mixed-custody-change", "broken-custody-chain", "live-custody-drift"
]) {
  test(`automatic pull identifies the custody incident: ${fault}`, async () => {
    const ctx = {
      outputs: new OutputStore(),
      config: { dataPath: "/tmp/unused-unit-wallet", clusterPath: "/tmp/unused-unit-cluster" }
    }
    const build = ClusterBuild.forContext(ctx)
    new EmergencyStopScenario().plan(build)
    const step = steps(build).find(value => value.name === "automatic-pull-evidence")
    Assert.ok(step)
    const mismatch = {
      chain_code: SyndicationScenario.Chain, token_code: SyndicationScenario.Token,
      epoch_index: 3, sequence: "7", kind: SysioContracts.SysioSyndItemKind.SYNDICATION,
      reported: "1000", expected: "1001", at: "2026-10-08T00:00:00"
    }
    ctx.outputs.set(Constants.ProbeEpoch, 3)
    mock.method(WireSyndicationTool, "readMismatches", async () => [mismatch])
    // The shortfall syndication leaves 1000 in the pool; the per-epoch
    // report_liq_yield crank then claims +1, so the live balance is 1001.
    const yieldClaim = custodyChange(
      "yield", fault === "mixed-custody-change"
        ? [SolanaLiqSyndicationTool.ReportLiqYieldInstructionName, "DonateToPool"]
        : [SolanaLiqSyndicationTool.ReportLiqYieldInstructionName],
      fault === "broken-custody-chain" ? 999n : 1000n, 1001n,
      fault !== "mixed-custody-change"
    )
    mock.method(SolanaLiqSyndicationTool, "readSyndicationCustody", async (_ctx, sequence) => {
      Assert.strictEqual(sequence, 7n)
      return {
        syndication: custodyChange("synd", ["Synd"], 900n, fault === "syndication-snapshot" ? 999n : 1000n),
        laterChanges: fault === "foreign-custody-change"
          ? [yieldClaim, custodyChange("donate", ["DonateToPool"], 1001n, 1002n)]
          : [yieldClaim]
      }
    })
    mock.method(SolanaLiqSyndicationTool, "readPoolBalance", async () => fault === "live-custody-drift" ? 1002n : 1001n)
    mock.method(WireSyndicationTool, "readOutstanding", async () => 1001n)
    const token = fault === "wrong-token" ? "LIQETH" : SyndicationScenario.Token
    const suffix = fault === "missing-sequence" ? "" : ` seq ${fault === "wrong-sequence" ? 8 : 7}`
    mock.method(WireSyndicationTool, "readCord", async () => ({
      pulled: fault !== "clear", when: mismatch.at,
      reason: `custody shortfall ${SyndicationScenario.Chain} ${token}${suffix}`
    }))
    const message = SyndicateLIQ.create({ amount: { amount: Constants.ProbeAmount }, sequence: 7n, totalSyndicated: 1000n })
    mock.method(EnvelopeScan, "readEnvelopeAttestations", async () => [SyndicateLIQ.toBinary(message)])
    const run = () => step.runner(ctx, step.input, new AbortController().signal)
    if (fault === "none") {
      await run()
      Assert.deepEqual(ctx.outputs.assert(Constants.Mismatches), [mismatch])
    } else await Assert.rejects(run)
  })
}
