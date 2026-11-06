const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const {
  BatchOperatorUnderwritingSteps,
  ClusterBuild,
  ClusterConfigProvider,
  ClusterKeyStore,
  Constants: HarnessConstants,
  OutputStore,
  SolanaLiqSyndicationTool,
  EthereumSyndicationTool,
  SyndicationScenario,
  WireCollateralTool,
  WireSyndicationTool
} = require("@wireio/cluster-tool")
const { KeyType, SysioContracts } = require("@wireio/sdk-core")
const {
  AttestationType,
  OperatorType
} = require("@wireio/opp-typescript-models")
const {
  SyndicationPluginUnderwritingScenario
} = require("../lib/SyndicationPluginUnderwritingScenario.js")
const {
  SyndicationPluginUnderwritingScenarioConstants: Constants
} = require("../lib/SyndicationPluginUnderwritingScenarioConstants.js")
afterEach(() => mock.restoreAll())

/** The input kind of the read-only parked-credit verify Steps. */
const ParkedCreditKind = "SyndicationUserSteps.ParkedCreditInput",
  SYND = AttestationType.SYNDICATE_LIQ,
  YIELD = AttestationType.LIQ_YIELD

const {
    SysioBondRequestState,
    SysioOpregOperatorstatus,
    SysioSyndEnvelopeState
  } = SysioContracts,
  firstFee = SyndicationScenario.feeOf(
    Constants.Plan.amount,
    Constants.Plan.feeBps
  ),
  operatorCount = 3,
  operatorAccount = index => `wireno.op${index}`

/** Flatten the planned flow so tests exercise the actual verification runners. */
function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

/** Plan the scenario against an in-memory context with three batch operators. */
function planned() {
  const keyStore = new ClusterKeyStore()
  for (let index = 0; index < operatorCount; index++)
    keyStore.setOperator({
      label: HarnessConstants.batchOperatorLabel(index),
      publicationLabel: HarnessConstants.batchOperatorLabel(index),
      account: operatorAccount(index),
      type: OperatorType.BATCH,
      wire: { type: KeyType.K1, publicKey: "PUB", privateKey: "PVT" }
    })
  const ctx = {
      outputs: new OutputStore(),
      keyStore,
      config: {
        dataPath: "/tmp/unused-unit-wallet",
        batchOperatorCount: operatorCount,
        batchOperatorUnderwriting: {
          fundedOperatorCount: operatorCount,
          maxExposure: [
            ...ClusterConfigProvider.DefaultBatchUnderwriterMaxExposures
          ]
        }
      }
    },
    build = ClusterBuild.forContext(ctx)
  new SyndicationPluginUnderwritingScenario().plan(build)
  ctx.outputs.set(Constants.Plan.before, {
    holder: 0n,
    operators: 300n,
    fees: 0n
  })
  return { ctx, all: steps(build) }
}

/** Run the named planned Step. */
function runner(ctx, all, name) {
  const step = all.find(value => value.name === name)
  Assert.ok(step, `no step ${name}`)
  return () => step.runner(ctx, step.input, new AbortController().signal)
}

test("after setup the flow pushes no underwriter action and provisions no bonder", () => {
  const { all } = planned(),
    configured = all.findIndex(step => step.name === "operators-funded"),
    after = all.slice(configured + 1),
    writes = after.map(step => step.input?.kind).filter(kind => kind != null)
  Assert.ok(configured > 0)
  // The only writes after setup are the users' own: three syndications and one createlink,
  // then the shared restoration of the pair rules. The typed parked-credit verifies are the
  // only other Steps with an input, and they read only.
  Assert.deepEqual(
    writes.filter(kind => kind !== ParkedCreditKind),
    [
      "SolanaLiqSyndicationTool.SyndInput",
      "SolanaLiqSyndicationTool.SyndInput",
      "SolanaLiqSyndicationTool.SyndInput",
      "SyndicationUserSteps.LinkSolanaKeyInput",
      "AccountSteps.CreateKeyedInput",
      "SyndicationUserSteps.ResourcePolicyInput",
      "SyndicationUserSteps.LinkEthereumKeyInput",
      "EthereumSyndicationTool.DepositLiqEthInput",
      "EthereumSyndicationTool.ApproveLiqEthInput",
      "EthereumSyndicationTool.SyndicateInput",
      "SyndicationScenario.RestoreConfigInput"
    ]
  )
  Assert.ok(!all.some(step => step.name === "create-bonder"))
})

test("the cluster runs the underwriter role on its batch operators", () => {
  const scenario = new SyndicationPluginUnderwritingScenario()
  Assert.equal(scenario.defaults.enableBatchOperatorUnderwriting, true)
  Assert.equal(scenario.defaults.enableMockSyndicationImport, true)
  Assert.equal(scenario.defaults.underwriterCount, 0)
  // No tuning: every operator is funded with a 10-token cap for each shadow.
  Assert.equal(scenario.defaults.batchOperatorUnderwriting, undefined)
  Assert.deepEqual(
    ClusterConfigProvider.resolveBatchOperatorUnderwriting(
      scenario.defaults,
      scenario.defaults.batchOperatorCount
    ),
    {
      fundedOperatorCount: 3,
      maxExposure: [
        ...ClusterConfigProvider.DefaultBatchUnderwriterMaxExposures
      ]
    }
  )
})

test("Ethereum acquisition has share-price headroom while syndication stays exact", () => {
  const { all } = planned(),
    deposit = all.find(step => step.name === "ethereum-deposit").input,
    syndicate = all.find(step => step.name === "ethereum-syndicate").input
  Assert.equal(deposit.amountWei, Constants.EthereumDepositAmount)
  Assert.ok(deposit.amountWei > syndicate.amount)
  Assert.equal(syndicate.amount, Constants.EthereumNativeAmount)
  Assert.equal(
    Constants.EthereumNativeAmount,
    Constants.EthereumPlan.amount * 1_000_000_000n
  )
})

// The second envelope may already be released when the first release is observed.
for (const secondReleased of [0n, Constants.Plan.laterAmount]) {
  for (const fault of ["none", "first", "second", "wallet", "fees"]) {
    test(`first release accounting with second released=${secondReleased}: ${fault}`, async () => {
      const { ctx, all } = planned(),
        secondFee = SyndicationScenario.feeOf(
          secondReleased,
          Constants.Plan.feeBps
        )
      mock.method(SyndicationScenario, "readEnvelope", async (_ctx, key) =>
        key === Constants.Plan.firstEpoch
          ? {
              released: Constants.Plan.amount.toString(),
              synd_total: (
                Constants.Plan.amount + (fault === "first" ? 1n : 0n)
              ).toString()
            }
          : {
              released: secondReleased.toString(),
              synd_total: (
                Constants.Plan.laterAmount + (fault === "second" ? 1n : 0n)
              ).toString(),
              state: SysioSyndEnvelopeState.REQUESTED,
              request_id: 2
            }
      )
      mock.method(
        SyndicationScenario,
        "readBalance",
        async () =>
          Constants.Plan.amount -
          firstFee +
          secondReleased -
          secondFee -
          (fault === "wallet" ? 1n : 0n)
      )
      mock.method(
        SyndicationScenario,
        "readFees",
        async () => firstFee + secondFee + (fault === "fees" ? 1n : 0n)
      )
      const run = runner(ctx, all, "first-released")
      if (fault === "none") await run()
      else await Assert.rejects(run)
    })
  }
}

for (const fault of ["none", "outsider", "over-cap", "short", "none-split"]) {
  test(`bonded check requires batch operators to cover it within the cap: ${fault}`, async () => {
    const { ctx, all } = planned(),
      covered = 2_010_000_000n
    ctx.outputs.set(Constants.Plan.firstRequest, 1)
    mock.method(WireSyndicationTool, "readRequest", async () => ({
      covered: covered.toString(),
      bonded: covered.toString(),
      state: SysioBondRequestState.BONDED
    }))
    const bonds = {
      none: [[operatorAccount(1), covered]],
      "none-split": [
        [operatorAccount(0), 10_000_000n],
        [operatorAccount(2), covered - 10_000_000n]
      ],
      outsider: [[SyndicationScenario.Bonder, covered]],
      "over-cap": [[operatorAccount(0), 10_000_000_001n]],
      short: [[operatorAccount(0), covered - 1n]]
    }[fault]
    mock.method(WireSyndicationTool, "readBonds", async () =>
      bonds.map(([underwriter, amount]) => ({
        underwriter,
        amount: amount.toString(),
        paid: false
      }))
    )
    const run = runner(ctx, all, "first-bonded")
    if (fault.startsWith("none")) await run()
    else await Assert.rejects(run)
  })
}

for (const over of [false, true]) {
  test(`an operator's unclaimed bonds across requests stay within its cap: over=${over}`, async () => {
    const { ctx, all } = planned(),
      covered = 5_000_000_000n
    ctx.outputs.set(Constants.Plan.firstRequest, 1)
    ctx.outputs.set(Constants.Plan.secondRequest, 2)
    mock.method(WireSyndicationTool, "readRequest", async () => ({
      covered: covered.toString(),
      bonded: covered.toString(),
      state: SysioBondRequestState.BONDED
    }))
    // Request 1's bond is still unpaid; request 2 is the one being verified.
    mock.method(WireSyndicationTool, "readBonds", async (_ctx, id) => [
      {
        underwriter: operatorAccount(0),
        amount: (id === 1
          ? over
            ? 5_000_000_001n
            : 5_000_000_000n
          : covered
        ).toString(),
        paid: false
      }
    ])
    const run = runner(ctx, all, "second-bonded")
    if (over) await Assert.rejects(run, /bonded and unclaimed, above/)
    else await run()
  })
}

for (const early of [false, true]) {
  test(`approval inside the challenge window is refused: early=${early}`, async () => {
    const { ctx, all } = planned()
    ctx.outputs.set(Constants.Plan.firstRequest, 1)
    mock.method(WireSyndicationTool, "readRequest", async () => ({
      state: SysioBondRequestState.APPROVED,
      bonded_at: "2026-10-13T00:00:00.000",
      window_sec: 60,
      resolved_at: early ? "2026-10-13T00:00:59.500" : "2026-10-13T00:01:00.000"
    }))
    mock.method(WireSyndicationTool, "readBonds", async () => [
      { underwriter: operatorAccount(0), amount: "1", paid: true }
    ])
    const run = runner(ctx, all, "first-approved-and-claimed")
    if (early) await Assert.rejects(run, /inside its 60s window/)
    else await run()
  })
}

for (const early of [false, true]) {
  test(`the second request is issued only after the first is bonded: early=${early}`, async () => {
    const { ctx, all } = planned()
    ctx.outputs.set(Constants.Plan.firstEpoch, 4)
    ctx.outputs.set(Constants.Plan.secondEpoch, 6)
    ctx.outputs.set(Constants.Plan.firstRequest, 1)
    ctx.outputs.set(Constants.Plan.secondRequest, 2)
    mock.method(WireSyndicationTool, "readRequest", async (_ctx, id) =>
      id === 1
        ? { bonded_at: "2026-10-13T00:00:10.000" }
        : {
            created_at: early
              ? "2026-10-13T00:00:09.500"
              : "2026-10-13T00:00:10.000"
          }
    )
    const run = runner(ctx, all, "queue-order")
    if (early) await Assert.rejects(run, /before request 1 was bonded/)
    else await run()
  })
}

for (const fault of ["none", "unpaid", "balance", "holder"]) {
  test(`operators and the holder settle exactly: ${fault}`, async () => {
    const { ctx, all } = planned()
    ctx.outputs.set(Constants.Plan.firstRequest, 1)
    ctx.outputs.set(Constants.Plan.secondRequest, 2)
    ctx.outputs.set(Constants.Plan.parkedRequest, 3)
    ctx.outputs.set(Constants.Plan.before, {
      holder: 10n,
      operators: 300n,
      fees: 2n
    })
    mock.method(WireSyndicationTool, "readBonds", async (_ctx, id) =>
      fault === "unpaid" && id === 2
        ? [{ underwriter: operatorAccount(0), amount: "1", paid: false }]
        : [{ underwriter: operatorAccount(1), amount: "1", paid: true }]
    )
    mock.method(SyndicationScenario, "readBalance", async (_ctx, account) =>
      account === SysioContracts.SysioContractAccount.synd
        ? 15n + (fault === "holder" ? 1n : 0n)
        : fault === "balance" && account === operatorAccount(2)
          ? 99n
          : 100n
    )
    mock.method(SyndicationScenario, "readFees", async () => 7n)
    const run = runner(ctx, all, "operators-settled")
    if (fault === "none") await run()
    else await Assert.rejects(run)
  })
}

for (const status of [
  SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE,
  SysioOpregOperatorstatus.OPERATOR_STATUS_SLASHED
]) {
  test(`operators stay ACTIVE: ${SysioOpregOperatorstatus[status]}`, async () => {
    const { ctx, all } = planned()
    mock.method(WireCollateralTool, "readOperatorRow", async (_ctx, label) => ({
      account: label,
      status:
        label === HarnessConstants.batchOperatorLabel(1)
          ? status
          : SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
    }))
    const run = runner(ctx, all, "operators-active")
    if (status === SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE) await run()
    else await Assert.rejects(run, /not ACTIVE/)
  })
}

/** Mock the outpost's settled custody: GlobalState, persisted attestations and the pool. */
function mockCustody({ state, attestations, pool, decoded }) {
  mock.method(SolanaLiqSyndicationTool, "readLiqYieldState", async () => state)
  mock.method(
    SyndicationScenario,
    "readCustodyAttestations",
    async () => attestations
  )
  mock.method(SolanaLiqSyndicationTool, "readPoolBalance", async () => pool)
  mock.method(
    SyndicationScenario,
    "readDecodedSyndications",
    async (_ctx, _user, amount) => decoded(amount)
  )
}

for (const fault of ["none", "pool", "covered", "unpersisted-user"]) {
  test(`first custody equals the newest total_syndicated: ${fault}`, async () => {
    const { ctx, all } = planned(),
      total = 410_000_000_000n + Constants.Plan.amount
    ctx.outputs.set(Constants.Plan.firstRequest, 1)
    mock.method(WireSyndicationTool, "readRequest", async () => ({
      covered: (
        SyndicationScenario.coveredOf(Constants.Plan.amount) -
        (fault === "covered" ? 1n : 0n)
      ).toString()
    }))
    mockCustody({
      state: {
        yieldAccumulatedLiqsol: 0n,
        liqYieldReported: 0n,
        liqSequence: 4n
      },
      attestations: [
        {
          type: SYND,
          sequence: 4n,
          amount: Constants.Plan.amount,
          totalSyndicated: total
        }
      ],
      pool: total + (fault === "pool" ? 1n : 0n),
      decoded: () => (fault === "unpersisted-user" ? [] : [{ sequence: 4n }])
    })
    const run = runner(ctx, all, "first-covered-custody")
    if (fault === "none") await run()
    else await Assert.rejects(run)
  })
}

for (const fault of ["none", "no-yield", "attested", "pool"]) {
  test(`second custody is exact across a LIQ_YIELD claim: ${fault}`, async () => {
    const { ctx, all } = planned(),
      firstTotal = 410_000_000_000n + Constants.Plan.amount,
      claimed = fault === "no-yield" ? 0n : 1n,
      secondTotal =
        firstTotal +
        claimed +
        Constants.Plan.laterAmount +
        (fault === "attested" ? 1n : 0n),
      // The yield claimed after the second syndication is in the pool and attested last.
      lastTotal = secondTotal + 1n,
      attestations = [
        {
          type: SYND,
          sequence: 4n,
          amount: Constants.Plan.amount,
          totalSyndicated: firstTotal
        },
        ...(claimed > 0n
          ? [
              {
                type: YIELD,
                sequence: 5n,
                amount: claimed,
                totalSyndicated: firstTotal + claimed
              }
            ]
          : []),
        {
          type: SYND,
          sequence: 6n,
          amount: Constants.Plan.laterAmount,
          totalSyndicated: secondTotal
        },
        { type: YIELD, sequence: 7n, amount: 1n, totalSyndicated: lastTotal }
      ]
    ctx.outputs.set(Constants.Plan.secondRequest, 2)
    mock.method(WireSyndicationTool, "readRequest", async () => ({
      covered: SyndicationScenario.coveredOf(
        Constants.Plan.laterAmount
      ).toString()
    }))
    mockCustody({
      state: {
        yieldAccumulatedLiqsol: 9n,
        liqYieldReported: 9n,
        liqSequence: 7n
      },
      attestations,
      pool: lastTotal + (fault === "pool" ? 1n : 0n),
      decoded: amount => [
        { sequence: amount === Constants.Plan.amount ? 4n : 6n }
      ]
    })
    const run = runner(ctx, all, "second-covered-custody")
    if (fault === "none" || fault === "no-yield") await run()
    else await Assert.rejects(run)
  })
}

test("custody waits for an unreported claim and its persisted LIQ_YIELD", async () => {
  const { ctx } = planned(),
    states = [
      { yieldAccumulatedLiqsol: 2n, liqYieldReported: 1n, liqSequence: 4n },
      { yieldAccumulatedLiqsol: 2n, liqYieldReported: 2n, liqSequence: 5n },
      { yieldAccumulatedLiqsol: 2n, liqYieldReported: 2n, liqSequence: 5n },
      { yieldAccumulatedLiqsol: 2n, liqYieldReported: 2n, liqSequence: 5n },
      { yieldAccumulatedLiqsol: 2n, liqYieldReported: 2n, liqSequence: 5n }
    ]
  let reads = 0,
    persisted = 0
  mock.method(
    SolanaLiqSyndicationTool,
    "readLiqYieldState",
    async () => states[Math.min(reads++, states.length - 1)]
  )
  mock.method(SyndicationScenario, "readCustodyAttestations", async () =>
    persisted++ === 0
      ? [{ type: SYND, sequence: 4n, amount: 1n, totalSyndicated: 10n }]
      : [
          { type: SYND, sequence: 4n, amount: 1n, totalSyndicated: 10n },
          { type: YIELD, sequence: 5n, amount: 1n, totalSyndicated: 11n }
        ]
  )
  mock.method(SolanaLiqSyndicationTool, "readPoolBalance", async () => 11n)
  const observation = await BatchOperatorUnderwritingSteps.readSettledCustody(
    ctx,
    "t"
  )
  Assert.equal(observation.pool, 11n)
  Assert.equal(observation.attestations.at(-1).sequence, 5n)
  Assert.ok(persisted >= 2)
})

test("setup funding requires every operator's exact credit", async () => {
  const { ctx, all } = planned()
  ctx.outputs = new OutputStore()
  const balances = new Map([
    [operatorAccount(0), 100_000_000_000n],
    [operatorAccount(1), 100_000_000_000n],
    [operatorAccount(2), 100_000_000_000n]
  ])
  mock.method(
    SyndicationScenario,
    "readBalance",
    async (_ctx, account) => balances.get(account) ?? 0n
  )
  mock.method(SyndicationScenario, "readFees", async () => 5n)
  await runner(ctx, all, "operators-funded")()
  Assert.deepEqual(ctx.outputs.assert(Constants.Plan.before), {
    holder: 0n,
    operators: 300_000_000_000n,
    fees: 5n
  })
  balances.set(operatorAccount(2), 1n)
  await Assert.rejects(
    runner(ctx, all, "operators-funded")(),
    /underwriting credit/
  )
})

// planVerifyRecorded: the first envelope after the floor with the amount and an issued request.
for (const fault of ["none", "earlier-epoch", "other-amount", "unissued"]) {
  test(`recorded envelope must follow the floor, match the amount and carry a request: ${fault}`, () => {
    const row = {
      epoch_index: fault === "earlier-epoch" ? 4 : 6,
      synd_total: (
        Constants.Plan.laterAmount + (fault === "other-amount" ? 1n : 0n)
      ).toString(),
      state:
        fault === "unissued"
          ? SysioSyndEnvelopeState.WAITING
          : SysioSyndEnvelopeState.REQUESTED,
      request_id: 9
    }
    Assert.equal(
      BatchOperatorUnderwritingSteps.findRecordedEnvelope(
        [row],
        Constants.Plan.laterAmount,
        5
      ),
      fault === "none" ? row : undefined
    )
  })
}

test("recorded step stores the envelope's epoch and request", async () => {
  const { ctx, all } = planned()
  ctx.outputs.set(Constants.Plan.firstEpoch, 5)
  mock.method(WireSyndicationTool, "readEnvelopes", async () => [
    {
      epoch_index: 6,
      synd_total: Constants.Plan.laterAmount.toString(),
      state: SysioSyndEnvelopeState.REQUESTED,
      request_id: 9
    }
  ])
  await runner(ctx, all, "second-requested")()
  Assert.equal(ctx.outputs.assert(Constants.Plan.secondEpoch), 6)
  Assert.equal(ctx.outputs.assert(Constants.Plan.secondRequest), 9)
})

for (const fault of ["none", "wallet", "fees"]) {
  test(`second drained requires both nets and both fees: ${fault}`, async () => {
    const { ctx, all } = planned(),
      laterFee = SyndicationScenario.feeOf(
        Constants.Plan.laterAmount,
        Constants.Plan.feeBps
      )
    ctx.outputs.set(Constants.Plan.secondEpoch, 6)
    mock.method(SyndicationScenario, "readEnvelope", async () => ({
      released: Constants.Plan.laterAmount.toString()
    }))
    mock.method(
      SyndicationScenario,
      "readBalance",
      async () =>
        Constants.Plan.amount -
        firstFee +
        Constants.Plan.laterAmount -
        laterFee -
        (fault === "wallet" ? 1n : 0n)
    )
    mock.method(
      SyndicationScenario,
      "readFees",
      async () => firstFee + laterFee + (fault === "fees" ? 1n : 0n)
    )
    const run = runner(ctx, all, "second-drained")
    if (fault === "none") await run()
    else await Assert.rejects(run)
  })
}

for (const fault of ["none", "pool", "missing"]) {
  test(`unlinked custody is exact and attested: ${fault}`, async () => {
    const { ctx, all } = planned(),
      total = 413_000_000_002n
    mockCustody({
      state: {
        yieldAccumulatedLiqsol: 0n,
        liqYieldReported: 0n,
        liqSequence: 8n
      },
      attestations: [
        {
          type: SYND,
          sequence: 8n,
          amount: Constants.Plan.laterAmount,
          totalSyndicated: total
        }
      ],
      pool: total + (fault === "pool" ? 1n : 0n),
      decoded: () => (fault === "missing" ? [] : [{ sequence: 8n }])
    })
    const run = runner(ctx, all, "unlinked-custody")
    if (fault === "none") await run()
    else await Assert.rejects(run)
  })
}

for (const released of [0n, Constants.Plan.laterAmount]) {
  test(`parked release is recognized only when whole: released=${released}`, async () => {
    const { ctx, all } = planned()
    ctx.outputs.set(Constants.Plan.parkedEpoch, 7)
    mock.method(SyndicationScenario, "readEnvelope", async () => ({
      released: released.toString()
    }))
    Assert.equal(
      await BatchOperatorUnderwritingSteps.isParkedReleased(
        ctx,
        Constants.Plan
      ),
      released === Constants.Plan.laterAmount
    )
    if (released === Constants.Plan.laterAmount)
      await runner(ctx, all, "unlinked-released")()
  })
}

test("first-release reading retries until the second envelope holds still", async () => {
  const { ctx } = planned()
  let secondReads = 0
  mock.method(SyndicationScenario, "readEnvelope", async (_ctx, key) => {
    if (key === Constants.Plan.firstEpoch)
      return { released: Constants.Plan.amount.toString(), synd_total: "0" }
    // First pass: 0 then all of it (moved mid-read); later passes: all of it both times.
    secondReads++
    return {
      released: (secondReads === 1
        ? 0n
        : Constants.Plan.laterAmount
      ).toString(),
      synd_total: Constants.Plan.laterAmount.toString()
    }
  })
  mock.method(SyndicationScenario, "readBalance", async () => 1n)
  mock.method(SyndicationScenario, "readFees", async () => 2n)
  const observation = await BatchOperatorUnderwritingSteps.readFirstRelease(
    ctx,
    "t",
    Constants.Plan
  )
  Assert.equal(BigInt(observation.second.released), Constants.Plan.laterAmount)
  Assert.ok(secondReads >= 4, "the moved reading must have been discarded")
})

test("Ethereum setup verifies funded capital and refuses a one-unit custody shortfall", async () => {
  const { ctx, all } = planned(),
    amount = 100_000_000_000n,
    outstanding = 410_000_000_000n
  mock.method(WireSyndicationTool, "readLiqBalance", async (_ctx, account) =>
    account === Constants.EthereumUser ? 0n : amount
  )
  mock.method(WireSyndicationTool, "readOutstanding", async () => outstanding)
  mock.method(WireSyndicationTool, "readSyndicationConfig", async () => ({
    synd_fee_bps: 0
  }))
  const custody = mock.method(
    EthereumSyndicationTool,
    "readPoolBalanceDepot",
    async () => outstanding
  )
  mock.method(
    EthereumSyndicationTool,
    "readSyndicatedPrincipal",
    async () => outstanding
  )
  await runner(ctx, all, "ethereum-underwriting-funded")()
  Assert.deepEqual(ctx.outputs.assert(Constants.EthereumBefore), {
    holder: 0n,
    operators: amount * BigInt(operatorCount)
  })
  custody.mock.mockImplementation(async () => outstanding - 1n)
  await Assert.rejects(runner(ctx, all, "ethereum-underwriting-funded"))
})

for (const short of [0n, 1n]) {
  test(`Ethereum settlement verifies actual wallet principal (${short} units short)`, async () => {
    const { ctx, all } = planned(),
      plan = Constants.EthereumPlan,
      capital = 100_000_000_000n,
      outstanding = 410_000_000_000n + plan.amount
    ctx.outputs.set(Constants.EthereumBefore, {
      holder: 0n,
      operators: capital * BigInt(operatorCount)
    })
    ctx.outputs.set(plan.firstEpoch, 2)
    mock.method(WireSyndicationTool, "readLiqBalance", async (_ctx, account) =>
      account === Constants.EthereumUser ? plan.amount - short : capital
    )
    mock.method(WireSyndicationTool, "readEnvelope", async () => ({
      synd_total: plan.amount.toString(),
      yield_total: "0",
      released: plan.amount.toString()
    }))
    mock.method(WireSyndicationTool, "readOutstanding", async () => outstanding)
    mock.method(WireSyndicationTool, "readMismatches", async () => [])
    mock.method(WireSyndicationTool, "readCord", async () => undefined)
    mock.method(
      EthereumSyndicationTool,
      "readPoolBalanceDepot",
      async () => outstanding
    )
    mock.method(
      EthereumSyndicationTool,
      "readSyndicatedPrincipal",
      async () => outstanding
    )
    if (short === 0n) await runner(ctx, all, "ethereum-settled")()
    else
      await Assert.rejects(
        runner(ctx, all, "ethereum-settled"),
        /entire LIQETH principal/
      )
  })
}
