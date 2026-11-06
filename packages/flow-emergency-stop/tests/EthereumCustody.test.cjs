const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const {
  ClusterBuild, OutputStore, Steps, SyndicationScenario,
  EthereumSyndicationTool, WireSyndicationTool
} = require("@wireio/cluster-tool")
const { EmergencyStopScenario } = require("../lib/EmergencyStopScenario.js")
const { EmergencyStopScenarioConstants: Constants } = require("../lib/EmergencyStopScenarioConstants.js")
const {
  createEthereumCustodyFixture, ethereumCustodyGapExceedsAllowance
} = require("../lib/ethereumCustodyFixture.js")

const snapshot = {
  custody: 110_000_000_000n,
  outstanding: 109_027_761_756n,
  redemption: Constants.EthereumRedemption,
  toleranceBps: 100n
}
const holder = "0x0000000000000000000000000000000000000001"
const signal = new AbortController().signal
afterEach(() => mock.restoreAll())

function scenario() {
  const rows = [{
    token_code: Constants.EthereumToken, holder: SyndicationScenario.Bonder,
    request_id: "23", amount: String(Constants.EthereumRedemption)
  }]
  const ctx = {
    outputs: new OutputStore(),
    wire: { getSysioContract: () => ({ tables: {
      returns: { query: async () => ({ rows, more: false }) }
    } }) }
  }
  const build = ClusterBuild.forContext(ctx)
  new EmergencyStopScenario().plan(build)
  return { ctx, build, rows }
}
const run = (step, ctx) => step.runner(ctx, step.input, signal)

for (const toleranceBps of [0n, 1n, 100n, 250n, 1000n]) {
  test(`funded shortfall uses actual ${toleranceBps} bps, net burn and integer products`, () => {
    const fixture = createEthereumCustodyFixture({ ...snapshot, toleranceBps }, true)
    Assert.equal(snapshot.outstanding + fixture.recredit - snapshot.redemption, fixture.postBurnOutstanding)
    Assert.equal(fixture.postBurnOutstanding - (snapshot.custody - snapshot.redemption), fixture.gap)
    Assert.ok(snapshot.custody >= snapshot.redemption)
    // Independent contract comparison; the denominator includes the newly credited gap.
    Assert.ok(fixture.gap * 10_000n > fixture.postBurnOutstanding * toleranceBps)
    Assert.ok(fixture.gap >= Constants.EthereumCustodyMargin + 1n)
    const lastAllowed = fixture.gap - Constants.EthereumCustodyMargin - 1n
    const remainingCustody = snapshot.custody - snapshot.redemption
    Assert.ok(lastAllowed * 10_000n <= (remainingCustody + lastAllowed) * toleranceBps)
    Assert.ok((lastAllowed + 1n) * 10_000n > (remainingCustody + lastAllowed + 1n) * toleranceBps)
    Assert.equal(Constants.Deficit, 10_000_000n)
  })
}

test("within-allowance fixture creates a positive funded gap with drift headroom", () => {
  const fixture = createEthereumCustodyFixture(snapshot, false)
  Assert.ok(fixture.gap > 0n)
  Assert.ok(fixture.gap * 10_000n < fixture.postBurnOutstanding * snapshot.toleranceBps)
  Assert.ok(fixture.recredit > snapshot.custody - snapshot.outstanding)
})

for (const invalid of [
  { toleranceBps: -1n }, { toleranceBps: 10_000n },
  { redemption: 0n }, { custody: Constants.EthereumRedemption - 1n },
  { outstanding: snapshot.custody + 1n }
]) test(`fixture rejects invalid measurements: ${Object.keys(invalid)[0]}`, () => {
  Assert.throws(() => createEthereumCustodyFixture({ ...snapshot, ...invalid }, true))
})

test("zero or sub-unit allowance cannot exercise a positive tolerated gap", () => {
  Assert.throws(() => createEthereumCustodyFixture({ ...snapshot, toleranceBps: 0n }, false))
  Assert.throws(() => createEthereumCustodyFixture({
    custody: 10n, outstanding: 10n, redemption: 1n, toleranceBps: 1n
  }, false))
})

test("ratio comparison accepts the inclusive boundary and refuses the first depot unit beyond it", () => {
  const check = { requestId: 23n, postPayoutBalanceDepot: 9900n, totalSyndicated: 10_000n, toleranceBps: 100n }
  Assert.equal(ethereumCustodyGapExceedsAllowance(check), false)
  Assert.equal(ethereumCustodyGapExceedsAllowance({ ...check, postPayoutBalanceDepot: 9899n }), true)
  Assert.equal(ethereumCustodyGapExceedsAllowance({ ...check, postPayoutBalanceDepot: 10_001n }), false)
  Assert.equal(ethereumCustodyGapExceedsAllowance({ ...check, postPayoutBalanceDepot: 0n, totalSyndicated: 0n }), false)
  Assert.equal(ethereumCustodyGapExceedsAllowance({ ...check, postPayoutBalanceDepot: 9999n, toleranceBps: 0n }), true)
  Assert.equal(ethereumCustodyGapExceedsAllowance({ ...check, postPayoutBalanceDepot: 9998n, toleranceBps: 1n, totalSyndicated: 9999n }), true)
})

for (const lane of ["EthereumWithinAllowance", "EthereumShortfall"])
test(`${lane} measures live fees and allowance without changing Solana funding`, async () => {
  const { ctx, build } = scenario()
  ctx.outputs.set(Constants.Shortfall, 99n)
  mock.method(EthereumSyndicationTool, "readPoolBalanceDepot", async () => snapshot.custody)
  mock.method(EthereumSyndicationTool, "readCustodyShortfallBps", async () => 250n)
  mock.method(WireSyndicationTool, "readOutstanding", async (_ctx, token) => {
    Assert.equal(token, Constants.EthereumToken)
    return snapshot.outstanding
  })
  const fee = mock.method(WireSyndicationTool, "readDesyndicationFee", async (_ctx, quantity) => {
    Assert.equal(quantity, "0.500000000 LIQETH")
    return String(Constants.Payout - Constants.EthereumRedemption)
  })
  mock.method(EthereumSyndicationTool, "hdWallet", () => ({ address: holder }))
  const donorBalance = mock.method(EthereumSyndicationTool, "readLiqEthBalance", async () => snapshot.custody * Constants.EthereumScale)
  const step = build.children.find(value => value.name === lane).steps.find(value => value.name === "measure-ethereum-shortfall")
  await run(step, ctx)
  Assert.equal(ctx.outputs.assert(Constants.EthereumToleranceBps), 250n)
  Assert.equal(ctx.outputs.assert(Constants.EthereumRecredit), createEthereumCustodyFixture({ ...snapshot, toleranceBps: 250n }, lane === "EthereumShortfall").recredit)
  Assert.equal(ctx.outputs.assert(Constants.Shortfall), 99n)
  donorBalance.mock.mockImplementation(async () => 0n)
  await Assert.rejects(run(step, ctx), /donor cannot fully fund/)
  donorBalance.mock.mockImplementation(async () => snapshot.custody * Constants.EthereumScale)
  fee.mock.mockImplementation(async () => "0")
  await Assert.rejects(run(step, ctx))
})

for (const lane of ["EthereumWithinAllowance", "EthereumShortfall"]) {
  for (const fault of ["none", "wrong ratio", "changed allowance", "no gap", "wrong recipient", "wrong amount", "wrong reason", "wrong pause", "changed balance", "pending remains"]) {
    // Deferred-only and tolerated-only faults retain their own meaningful assertions.
    const tolerated = lane === "EthereumWithinAllowance"
    if (tolerated && ["wrong recipient", "wrong reason", "changed balance"].includes(fault)) continue
    if (tolerated && fault === "wrong amount") continue
    if (!tolerated && fault === "pending remains") continue
    test(`${lane} verifies actual settlement custody: ${fault}`, async () => {
      const { ctx, build } = scenario()
      ctx.outputs.set(Constants.LastRequest, 22n)
      ctx.outputs.set(Constants.EthereumBefore, 77n)
      ctx.outputs.set(Constants.EthereumToleranceBps, 100n)
      mock.method(Steps.registry, "readMockSyndicationBonder", () => ({ ethereum: { address: holder } }))
      mock.method(EthereumSyndicationTool, "readPaused", async () => fault === "wrong pause" ? tolerated : !tolerated)
      mock.method(EthereumSyndicationTool, "readLiqEthBalance", async () => fault === "changed balance" ? 78n : 77n)
      mock.method(EthereumSyndicationTool, "readPendingDesyndication", async () => tolerated && fault !== "pending remains" ? undefined : {
        recipient: fault === "wrong recipient" ? "0x0000000000000000000000000000000000000002" : holder,
        depotAmount: Constants.EthereumRedemption + (fault === "wrong amount" ? 1n : 0n),
        reason: fault === "wrong reason" ? EthereumSyndicationTool.PendingPayoutReason.OUTPOST_FROZEN : EthereumSyndicationTool.PendingPayoutReason.CUSTODY_SHORTFALL
      })
      mock.method(EthereumSyndicationTool, "readCustodyCheck", async (_ctx, requestId, amount, accepted) => {
        Assert.equal(requestId, 23n)
        Assert.equal(amount, Constants.EthereumRedemption)
        Assert.equal(accepted, tolerated)
        return {
          requestId, totalSyndicated: 10_000n,
          postPayoutBalanceDepot: fault === "no gap" ? 10_000n : (fault === "wrong ratio" ? !tolerated : tolerated) ? 9900n : 9899n,
          toleranceBps: fault === "changed allowance" ? 250n : 100n
        }
      })
      const step = build.children.find(value => value.name === lane).steps.find(value => value.name === (tolerated ? "ethereum-tolerated" : "ethereum-stored"))
      if (fault === "none") {
        await run(step, ctx)
        Assert.equal(ctx.outputs.assert(Constants.EthereumRequest), 23n)
      } else await Assert.rejects(run(step, ctx))
    })
  }
}

test("tolerated lane never pauses or calls the pending-payment recovery crank", () => {
  const { build } = scenario()
  const phase = build.children.find(value => value.name === "EthereumWithinAllowance")
  Assert.deepEqual(phase.steps.map(value => value.name), [
    "fund-ethereum-repair", "measure-ethereum-shortfall", "ethereum-before", "unbacked-ethereum-recredit",
    "ethereum-redemption", "ethereum-tolerated",
    "repair-ethereum-custody", "ethereum-custody-repaired", "ethereum-paid", "second-ethereum-payment-refused",
    "ethereum-still-paid-once"
  ])
})

for (const tolerated of [true, false]) {
  test(`repair must fully back outstanding and the unpaid redemption, tolerated=${tolerated}`, async () => {
    const { ctx, build } = scenario()
    const phase = build.children.find(value => value.name === (tolerated ? "EthereumWithinAllowance" : "EthereumShortfall"))
    const step = phase.steps.find(value => value.name === "ethereum-custody-repaired")
    const required = snapshot.outstanding + (tolerated ? 0n : Constants.EthereumRedemption)
    const custody = mock.method(EthereumSyndicationTool, "readPoolBalanceDepot", async () => required)
    mock.method(WireSyndicationTool, "readOutstanding", async () => snapshot.outstanding)
    mock.method(EthereumSyndicationTool, "readPaused", async () => !tolerated)
    await run(step, ctx)
    custody.mock.mockImplementation(async () => required - 1n)
    await Assert.rejects(run(step, ctx), /repair is incomplete/)
  })
}
