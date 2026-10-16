const Assert = require("node:assert/strict")
const { test, afterEach, mock } = require("node:test")
const {
  ClusterBuild,
  ClusterConfigProvider,
  ClusterKeyStore,
  BatchOperatorUnderwritingSteps,
  Constants: HarnessConstants,
  OperatorDaemonTool,
  ProtocolTiming,
  OutputStore,
  SyndicationScenario,
  WireSyndicationTool
} = require("@wireio/cluster-tool")
const { KeyType, SysioContracts } = require("@wireio/sdk-core")
const { OperatorType } = require("@wireio/opp-typescript-models")
const { Deferred } = require("@wireio/shared")
const {
  SyndicationPluginUnderwritingCapScenario
} = require("../lib/SyndicationPluginUnderwritingCapScenario.js")
const {
  SyndicationPluginUnderwritingCapScenarioConstants: Constants
} = require("../lib/SyndicationPluginUnderwritingCapScenarioConstants.js")
const {
  SyndicationPluginUnderwritingCapSteps
} = require("../lib/steps/index.js")
const { InitialHeld } = require("../lib/orchestration/index.js")
afterEach(() => {
  mock.restoreAll()
  mock.timers.reset()
})

/** The input kind of the read-only parked-credit verify Steps. */
const ParkedCreditKind = "SyndicationUserSteps.ParkedCreditInput",
  { SysioBondRequestState, SysioSyndEnvelopeState } = SysioContracts,
  operatorCount = 3,
  operatorAccount = index => `wireno.op${index}`,
  funded = operatorAccount(0)

/** Flatten the planned flow so tests exercise the actual verification runners. */
function steps(node) {
  return node.steps ? [...node.steps] : node.children.flatMap(steps)
}

/** Plan the scenario against an in-memory context: three operators, the first one funded. */
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
          fundedOperatorCount: Constants.FundedOperatorCount,
          maxExposure: [Constants.UnderwriterExposureCap]
        }
      }
    },
    build = ClusterBuild.forContext(ctx)
  new SyndicationPluginUnderwritingCapScenario().plan(build)
  ctx.outputs.set(Constants.Plan.before, {
    holder: 0n,
    operators: 100n,
    fees: 0n
  })
  ctx.outputs.set(Constants.Plan.firstRequest, 1)
  ctx.outputs.set(Constants.Plan.secondRequest, 2)
  return { ctx, build, all: steps(build) }
}

/** Run the named planned Step. */
function runner(ctx, all, name) {
  const step = all.find(value => value.name === name)
  Assert.ok(step, `no step ${name}`)
  return () => step.runner(ctx, step.input, new AbortController().signal)
}

test("after setup the flow changes only later request governance and user state, never underwriting", () => {
  const { all } = planned(),
    configured = all.findIndex(step => step.name === "operators-funded"),
    writes = all
      .slice(configured + 1)
      .map(step => step.input?.kind)
      .filter(kind => kind != null)
  Assert.ok(configured > 0)
  Assert.deepEqual(
    writes.filter(kind => kind !== ParkedCreditKind),
    [
      "SolanaLiqSyndicationTool.SyndInput",
      "SyndContractSteps.SetconfigInput",
      "SolanaLiqSyndicationTool.SyndInput",
      "SolanaLiqSyndicationTool.SyndInput",
      "SyndicationUserSteps.LinkSolanaKeyInput",
      "SyndicationScenario.RestoreConfigInput"
    ]
  )
  Assert.ok(!all.some(step => step.name === "create-bonder"))
})

test("the cluster funds one operator with a cap of exactly the first coverage", () => {
  const scenario = new SyndicationPluginUnderwritingCapScenario(),
    resolved = ClusterConfigProvider.resolveBatchOperatorUnderwriting(
      scenario.defaults,
      scenario.defaults.batchOperatorCount
    )
  Assert.equal(scenario.defaults.enableBatchOperatorUnderwriting, true)
  Assert.equal(resolved.fundedOperatorCount, 1)
  Assert.equal(resolved.maxExposure.length, 1)
  Assert.equal(
    resolved.maxExposure[0].amount,
    SyndicationScenario.coveredOf(Constants.Plan.amount)
  )
  Assert.equal(resolved.maxExposure[0].tokenCode, SyndicationScenario.TokenCode)
  // The cap cannot hold the first and second coverage together.
  Assert.ok(
    resolved.maxExposure[0].amount <
      Constants.FirstCovered +
        SyndicationScenario.coveredOf(Constants.Plan.laterAmount)
  )
  const { all } = planned(),
    firstRequested = all.findIndex(step => step.name === "first-requested"),
    laterConfig = all.findIndex(
      step => step.name === "configure-later-requests"
    ),
    secondSyndication = all.findIndex(
      step => step.name === "second-syndication"
    ),
    secondRequested = all.findIndex(step => step.name === "second-requested")
  Assert.ok(firstRequested < laterConfig && laterConfig < secondSyndication)
  Assert.equal(
    all[laterConfig].input.data.window_sec,
    ProtocolTiming.SyndicationChallengeWindowSec
  )
  Assert.ok(secondRequested < secondSyndication)
  Assert.equal(all[secondSyndication + 1].name, "second-held-by-cap")
  Assert.ok(
    all.findIndex(step => step.name === "first-covered-custody") >
      secondRequested + 1
  )
  Assert.ok(
    all.findIndex(step => step.name === "second-covered-custody") >
      secondRequested + 1
  )
})

const openSecond = {
  id: 2,
  created_at: "2026-10-14T00:03:00.000",
  state: SysioBondRequestState.OPEN,
  bonded: "0",
  covered: SyndicationScenario.coveredOf(Constants.Plan.laterAmount).toString()
}

/** Request 1 as the paid reading of its bond finds it. */
const firstApproved = {
  id: 1,
  state: SysioBondRequestState.APPROVED,
  resolved_at: "2026-10-14T00:04:00.000"
}

/**
 * Mock the held-by-cap reads: the funded bond of request 1 takes `first[n]` on its n-th read
 * (`unpaid`, `paid` or `gone`, the last state repeating); request 2 takes `seconds[n]` on its
 * n-th read and has `secondBonds`.
 */
function mockHeldRows({ first, seconds = [openSecond], secondBonds = [] }) {
  let firstReads = 0,
    secondReads = 0
  const at = (list, index) => list[Math.min(index, list.length - 1)]
  mock.method(WireSyndicationTool, "readBonds", async (_ctx, id) => {
    if (id !== 1) return secondBonds
    const state = at(first, firstReads++)
    return state === "gone"
      ? []
      : [
          {
            underwriter: funded,
            amount: Constants.FirstCovered.toString(),
            paid: state === "paid"
          }
        ]
  })
  mock.method(WireSyndicationTool, "readRequest", async (_ctx, id) =>
    id === 1 ? firstApproved : at(seconds, secondReads++)
  )
}

for (const [label, first, expected] of [
  ["held, then paid", ["unpaid", "unpaid", "paid"], null],
  ["paid before any reading", ["paid"], /before any reading/],
  ["paid between the reads", ["unpaid", "paid"], /before any reading/],
  ["row gone before a paid reading", ["unpaid", "unpaid", "gone"], /vanished/],
  ["row gone between the reads", ["unpaid", "gone"], /vanished/]
]) {
  test(`second-held-by-cap watches the first bond until paid: ${label}`, async () => {
    const { ctx, all } = planned()
    mockHeldRows({ first })
    const run = runner(ctx, all, "second-held-by-cap")
    if (expected == null) await run()
    else await Assert.rejects(run, expected)
  })
}

test("second-held-by-cap checks every reading, not only the first", async () => {
  const { ctx, all } = planned()
  mockHeldRows({
    first: ["unpaid", "unpaid", "unpaid", "unpaid", "paid"],
    seconds: [
      openSecond,
      { ...openSecond, state: SysioBondRequestState.BONDED }
    ]
  })
  await Assert.rejects(
    runner(ctx, all, "second-held-by-cap"),
    /reading 2, while the first bond is unpaid/
  )
})

for (const fault of ["bonded", "bond-row", "not-open"]) {
  test(`a held reading is OPEN with nothing bonded and no bond row: ${fault}`, async () => {
    const { ctx, all } = planned()
    mockHeldRows({
      first: ["unpaid", "unpaid", "paid"],
      seconds: [
        {
          ...openSecond,
          bonded: fault === "bonded" ? "1" : "0",
          state:
            fault === "not-open"
              ? SysioBondRequestState.BONDED
              : SysioBondRequestState.OPEN
        }
      ],
      secondBonds:
        fault === "bond-row"
          ? [{ underwriter: funded, amount: "1", paid: false }]
          : []
    })
    await Assert.rejects(runner(ctx, all, "second-held-by-cap"), /reading 1/)
  })
}

test("the held watch is budgeted at the window plus two plugin passes", () => {
  Assert.equal(
    SyndicationPluginUnderwritingCapSteps.heldBudgetMs(
      Constants.ChallengeWindowSec
    ),
    Constants.ChallengeWindowSec * 1_000 +
      2 * OperatorDaemonTool.BatchEpochPollMs
  )
  const step = planned().all.find(value => value.name === "second-held-by-cap")
  Assert.ok(
    step.options.timeoutMs >
      SyndicationPluginUnderwritingCapSteps.heldBudgetMs(
        Constants.ChallengeWindowSec
      )
  )
})

test("windows cover submission, a busy hop, governance finality and reads within the PR head", () => {
  Assert.equal(
    Constants.ChallengeWindowSec,
    SyndicationScenario.EpochDurationSec +
      (ProtocolTiming.SingleHopBudgetMs +
        ProtocolTiming.irreversibilityBudgetMs(Constants.ProducerCount) +
        2 * OperatorDaemonTool.BatchEpochPollMs +
        SyndicationScenario.PollMs) /
        ProtocolTiming.MsPerSecond
  )
  Assert.equal(Constants.ChallengeWindowSec, 589)
  Assert.equal(Constants.Config.window_sec, Constants.ChallengeWindowSec)
  Assert.equal(
    Constants.LaterConfig.window_sec,
    ProtocolTiming.SyndicationChallengeWindowSec
  )
  Assert.equal(
    Constants.Config.window_sec + 2 * Constants.LaterConfig.window_sec,
    709
  )
  Assert.ok(
    Constants.Config.window_sec + 2 * Constants.LaterConfig.window_sec <=
      3 * 240
  )
})

test("timeout scaling raises deadlines without lengthening on-chain windows", () => {
  const previous = process.env.WIRE_FLOW_TIMEOUT_SCALE
  try {
    for (const scale of [2, 5]) {
      process.env.WIRE_FLOW_TIMEOUT_SCALE = String(scale)
      const windowSec = Constants.ChallengeWindowSec,
        budget = SyndicationPluginUnderwritingCapSteps.heldBudgetMs(windowSec)
      Assert.equal(
        budget * scale,
        scale * (windowSec * 1_000 + 2 * OperatorDaemonTool.BatchEpochPollMs)
      )
      Assert.equal(
        SyndicationPluginUnderwritingCapSteps.heldOptions(windowSec).timeoutMs *
          scale,
        scale *
          (windowSec * 1_000 +
            2 * OperatorDaemonTool.BatchEpochPollMs +
            ProtocolTiming.PollDeadlineBufferMs)
      )
      Assert.equal(Constants.Config.window_sec, 589)
      Assert.equal(Constants.LaterConfig.window_sec, 60)
    }
  } finally {
    if (previous == null) delete process.env.WIRE_FLOW_TIMEOUT_SCALE
    else process.env.WIRE_FLOW_TIMEOUT_SCALE = previous
  }
})

for (const intakeDelaySec of [300, Constants.ChallengeWindowSec - 1]) {
  test(`intake at ${intakeDelaySec}s captures a hold even if payment precedes the follow-up watch`, async () => {
    mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2026-10-14T00:00:00Z")
    })
    const started = Date.now(),
      { ctx, all } = planned(),
      intakeDelayMs = intakeDelaySec * ProtocolTiming.MsPerSecond,
      firstPaidAt = started + Constants.ChallengeWindowSec * 1_000,
      fee = amount => SyndicationScenario.feeOf(amount, Constants.Plan.feeBps)
    mock.method(Deferred, "delay", async ms => mock.timers.tick(ms))
    mock.method(WireSyndicationTool, "readEnvelopes", async () =>
      Date.now() - started < intakeDelayMs
        ? []
        : [
            {
              epoch_index: 6,
              synd_total: Constants.Plan.laterAmount.toString(),
              state: SysioSyndEnvelopeState.REQUESTED,
              request_id: 2
            }
          ]
    )
    ctx.outputs.set(Constants.Plan.firstEpoch, 4)
    let heldReads = 0
    mock.method(WireSyndicationTool, "readBonds", async (_ctx, id) =>
      id === 1
        ? [
            {
              underwriter: funded,
              amount: Constants.FirstCovered.toString(),
              paid: Date.now() >= firstPaidAt
            }
          ]
        : []
    )
    mock.method(WireSyndicationTool, "readRequest", async (_ctx, id) => {
      if (id === 1) return firstApproved
      heldReads++
      return openSecond
    })
    await runner(ctx, all, "second-requested")()
    Assert.equal(Date.now() - started, intakeDelayMs)
    Assert.equal(heldReads, 1)
    Assert.equal(ctx.outputs.assert(InitialHeld).heldReadings, 1)
    // The next Step is delayed past payment; intake's bracketed reading remains evidence.
    mock.timers.tick(firstPaidAt - Date.now())
    await runner(ctx, all, "second-held-by-cap")()
    Assert.equal(heldReads, 1)
    // Persistence consumes both custody envelopes after the watch; second release is healthy.
    mock.timers.tick(2 * ProtocolTiming.SingleHopBudgetMs)
    mock.method(SyndicationScenario, "readEnvelope", async (_ctx, key) => ({
      released: (key === Constants.Plan.firstEpoch
        ? Constants.Plan.amount
        : Constants.Plan.laterAmount
      ).toString(),
      synd_total: (key === Constants.Plan.firstEpoch
        ? Constants.Plan.amount
        : Constants.Plan.laterAmount
      ).toString()
    }))
    mock.method(
      SyndicationScenario,
      "readBalance",
      async () =>
        Constants.Plan.amount -
        fee(Constants.Plan.amount) +
        Constants.Plan.laterAmount -
        fee(Constants.Plan.laterAmount)
    )
    mock.method(
      SyndicationScenario,
      "readFees",
      async () => fee(Constants.Plan.amount) + fee(Constants.Plan.laterAmount)
    )
    await runner(ctx, all, "first-released")()
  })
}

for (const paymentRead of ["discovery", "request", "bonds"]) {
  test(`payment during intake ${paymentRead} preserves captured hold evidence`, async () => {
    mock.timers.enable({
      apis: ["Date"],
      now: Date.parse("2026-10-14T00:00:00Z")
    })
    const started = Date.now(),
      { ctx, all } = planned(),
      paidAt =
        started + Constants.ChallengeWindowSec * ProtocolTiming.MsPerSecond
    // Charge governance, submission, the full hop and two passes before discovery.
    mock.timers.tick(
      ProtocolTiming.irreversibilityBudgetMs(Constants.ProducerCount) +
        SyndicationScenario.EpochDurationSec * ProtocolTiming.MsPerSecond +
        ProtocolTiming.SingleHopBudgetMs +
        2 * OperatorDaemonTool.BatchEpochPollMs
    )
    ctx.outputs.set(Constants.Plan.firstEpoch, 4)
    let secondSnapshot = false
    const pay = () => mock.timers.tick(paidAt - Date.now())
    mock.method(WireSyndicationTool, "readEnvelopes", async () => {
      if (paymentRead === "discovery") pay()
      return [
        {
          epoch_index: 6,
          synd_total: Constants.Plan.laterAmount.toString(),
          state: SysioSyndEnvelopeState.REQUESTED,
          request_id: 2
        }
      ]
    })
    mock.method(WireSyndicationTool, "readRequest", async (_ctx, id) => {
      if (id === 1) return firstApproved
      if (paymentRead === "request") pay()
      secondSnapshot = true
      return openSecond
    })
    mock.method(WireSyndicationTool, "readBonds", async (_ctx, id) => {
      if (id === 1)
        return [
          {
            underwriter: funded,
            amount: Constants.FirstCovered.toString(),
            paid: Date.now() >= paidAt
          }
        ]
      Assert.equal(secondSnapshot, true)
      if (paymentRead === "bonds") pay()
      // Bonding follows payment between the request snapshot and this RPC.
      return [{ underwriter: funded, amount: "40", paid: false }]
    })
    await runner(ctx, all, "second-requested")()
    Assert.equal(Date.now() - started, Constants.ChallengeWindowSec * 1_000)
    const initial = ctx.outputs.assert(InitialHeld)
    Assert.equal(initial.heldReadings, 1)
    Assert.equal(initial.firstBond.paid, false)
    Assert.equal(initial.paidBond.paid, true)
    Assert.equal(initial.firstResolvedAt, firstApproved.resolved_at)
    await runner(ctx, all, "second-held-by-cap")()
  })
}

for (const fault of [
  "missing-created",
  "issued-at-approval",
  "issued-after-approval",
  "already-bonded"
]) {
  test(`payment during intake refuses unsupported evidence: ${fault}`, async () => {
    const { ctx, all } = planned()
    ctx.outputs.set(Constants.Plan.firstEpoch, 4)
    const second = {
      ...openSecond,
      created_at:
        fault === "missing-created"
          ? null
          : fault === "issued-at-approval"
            ? firstApproved.resolved_at
            : fault === "issued-after-approval"
              ? "2026-10-14T00:04:01.000"
              : openSecond.created_at,
      bonded: fault === "already-bonded" ? "40" : "0"
    }
    mockHeldRows({ first: ["unpaid", "paid"], seconds: [second] })
    mock.method(WireSyndicationTool, "readEnvelopes", async () => [
      {
        epoch_index: 6,
        synd_total: Constants.Plan.laterAmount.toString(),
        state: SysioSyndEnvelopeState.REQUESTED,
        request_id: 2
      }
    ])
    await Assert.rejects(runner(ctx, all, "second-requested"))
    Assert.equal(ctx.outputs.has(InitialHeld), false)
  })
}

for (const fault of ["paid-before", "bonded", "bond-row", "gone", "over-cap"]) {
  test(`second intake refuses an unproven hold: ${fault}`, async () => {
    const { ctx, all } = planned()
    ctx.outputs.set(Constants.Plan.firstEpoch, 4)
    mockHeldRows({
      first:
        fault === "paid-before"
          ? ["paid"]
          : fault === "gone"
            ? ["gone"]
            : ["unpaid"],
      seconds:
        fault === "bonded" ? [{ ...openSecond, bonded: "1" }] : [openSecond],
      secondBonds:
        fault === "bond-row"
          ? [{ underwriter: funded, amount: "1", paid: false }]
          : []
    })
    mock.method(WireSyndicationTool, "readEnvelopes", async () => [
      {
        epoch_index: 6,
        synd_total: Constants.Plan.laterAmount.toString(),
        state: SysioSyndEnvelopeState.REQUESTED,
        request_id: 2
      }
    ])
    if (fault === "over-cap")
      ctx.config.batchOperatorUnderwriting.maxExposure = [
        { ...Constants.UnderwriterExposureCap, amount: 1n }
      ]
    await Assert.rejects(runner(ctx, all, "second-requested"))
    Assert.equal(ctx.outputs.has(InitialHeld), false)
  })
}

test("the parallel intake phase starts observation before submission", async () => {
  const { ctx, build, all } = planned(),
    phase = build.children.find(child => child.name === "SecondIntake"),
    syndication = all.find(step => step.name === "second-syndication")
  ctx.outputs.set(Constants.Plan.firstEpoch, 4)
  ctx.completedPhases = []
  ctx.log = { info() {}, error() {} }
  let started = false,
    submitted = false
  mock.method(WireSyndicationTool, "readBonds", async (_ctx, id) => {
    if (id !== 1) return []
    started = true
    return [
      {
        underwriter: funded,
        amount: Constants.FirstCovered.toString(),
        paid: false
      }
    ]
  })
  mock.method(syndication, "runner", async () => {
    Assert.equal(started, true)
    submitted = true
  })
  mock.method(WireSyndicationTool, "readEnvelopes", async () =>
    submitted
      ? [
          {
            epoch_index: 6,
            synd_total: Constants.Plan.laterAmount.toString(),
            state: SysioSyndEnvelopeState.REQUESTED,
            request_id: 2
          }
        ]
      : []
  )
  mock.method(WireSyndicationTool, "readRequest", async () => openSecond)
  const nodes = await phase.run(new AbortController().signal)
  Assert.ok(nodes.every(node => node.succeeded))
  Assert.equal(ctx.outputs.assert(InitialHeld).heldReadings, 1)
})

test("intake cancellation stops before another chain read", async () => {
  const { ctx, all } = planned(),
    step = all.find(value => value.name === "second-requested"),
    controller = new AbortController()
  ctx.outputs.set(Constants.Plan.firstEpoch, 4)
  mockHeldRows({ first: ["unpaid"] })
  let envelopeReads = 0
  mock.method(WireSyndicationTool, "readEnvelopes", async () => {
    envelopeReads++
    controller.abort()
    return []
  })
  mock.method(Deferred, "delay", async () => {})
  await Assert.rejects(
    () => step.runner(ctx, step.input, controller.signal),
    /aborted/
  )
  Assert.equal(envelopeReads, 1)
  Assert.equal(ctx.outputs.has(InitialHeld), false)
})

test("heldObservation stamps the paid reading with the first approval", () => {
  const observation = SyndicationPluginUnderwritingCapSteps.heldObservation(
    ["2026-10-14T00:03:00.000Z", "2026-10-14T00:04:10.000Z"],
    null,
    { underwriter: funded, amount: "1", paid: 1 },
    firstApproved
  )
  Assert.equal(observation.heldReadings, 2)
  Assert.equal(observation.firstHeldAt, "2026-10-14T00:03:00.000Z")
  Assert.equal(observation.lastHeldAt, "2026-10-14T00:04:10.000Z")
  Assert.equal(observation.firstResolvedAt, firstApproved.resolved_at)
})

// The hold is already proven; custody persistence can lag the second release.
for (const secondReleased of [0n, Constants.Plan.laterAmount, 1n]) {
  test(`first-released accounts for post-recovery progress: ${secondReleased}`, async () => {
    const { ctx, all } = planned(),
      firstFee = SyndicationScenario.feeOf(
        Constants.Plan.amount,
        Constants.Plan.feeBps
      ),
      secondFee = SyndicationScenario.feeOf(
        secondReleased,
        Constants.Plan.feeBps
      )
    ctx.outputs.set(Constants.Plan.firstEpoch, 4)
    ctx.outputs.set(Constants.Plan.secondEpoch, 6)
    mock.method(SyndicationScenario, "readEnvelope", async (_ctx, key) =>
      key === Constants.Plan.firstEpoch
        ? {
            released: Constants.Plan.amount.toString(),
            synd_total: Constants.Plan.amount.toString()
          }
        : {
            released: secondReleased.toString(),
            synd_total: Constants.Plan.laterAmount.toString()
          }
    )
    mock.method(
      SyndicationScenario,
      "readBalance",
      async () => Constants.Plan.amount - firstFee + secondReleased - secondFee
    )
    mock.method(
      SyndicationScenario,
      "readFees",
      async () => firstFee + secondFee
    )
    const run = runner(ctx, all, "first-released")
    if (secondReleased !== 1n) await run()
    else await Assert.rejects(run, /neither nothing nor all/)
  })
}

test("readFundedBond refuses a cluster that funds more than one operator", async () => {
  const { ctx } = planned()
  ctx.config.batchOperatorUnderwriting.fundedOperatorCount = 2
  await Assert.rejects(
    SyndicationPluginUnderwritingCapSteps.readFundedBond(ctx, 1),
    /exactly one funded batch operator, the cluster funds 2/
  )
})

for (const fault of [
  "none",
  "early",
  "first-unpaid",
  "second-paid",
  "second-missing",
  "paid-balance-off",
  "balance-off"
]) {
  test(`the second request is bonded after recovery with the stake accounted: ${fault}`, async () => {
    const { ctx, all } = planned()
    mock.method(WireSyndicationTool, "readRequest", async (_ctx, id) =>
      id === 1
        ? {
            id: 1,
            state: SysioBondRequestState.APPROVED,
            resolved_at: "2026-10-14T00:04:00.000"
          }
        : {
            id: 2,
            bonded_at:
              fault === "early"
                ? "2026-10-14T00:03:59.500"
                : "2026-10-14T00:04:15.000"
          }
    )
    mock.method(WireSyndicationTool, "readBonds", async (_ctx, id) =>
      id === 2 && fault === "second-missing"
        ? []
        : [
            id === 1
              ? {
                  underwriter: funded,
                  amount: "100",
                  paid: fault !== "first-unpaid"
                }
              : {
                  underwriter: funded,
                  amount: "40",
                  paid: fault === "second-paid" || fault === "paid-balance-off"
                }
          ]
    )
    mock.method(SyndicationScenario, "readBalance", async (_ctx, account) =>
      account === funded
        ? fault === "balance-off"
          ? 61n
          : fault === "second-paid"
            ? 100n
            : fault === "paid-balance-off"
              ? 99n
              : 60n
        : 0n
    )
    const run = runner(ctx, all, "second-bonded-after-recovery")
    if (fault === "none" || fault === "second-paid") await run()
    else
      await Assert.rejects(
        run,
        {
          early: /before request 1 was approved/,
          "first-unpaid": /first bond is not paid back/,
          "second-missing": /no bond on request 2/,
          "paid-balance-off": /plus its stake on the second request/,
          "balance-off": /plus its stake on the second request/
        }[fault]
      )
  })
}

for (const fault of ["none", "unfunded-holds", "outsider-bond", "over-cap"]) {
  test(`only the funded operator bonds, within its cap: ${fault}`, async () => {
    const { ctx, all } = planned(),
      covered = Constants.FirstCovered
    mock.method(WireSyndicationTool, "readRequest", async () => ({
      covered: covered.toString(),
      bonded: covered.toString(),
      state: SysioBondRequestState.BONDED
    }))
    mock.method(WireSyndicationTool, "readBonds", async (_ctx, id) =>
      id === 1
        ? [
            {
              underwriter:
                fault === "outsider-bond" ? operatorAccount(1) : funded,
              amount: covered.toString(),
              paid: false
            }
          ]
        : fault === "over-cap"
          ? [{ underwriter: funded, amount: "1", paid: false }]
          : []
    )
    mock.method(SyndicationScenario, "readBalance", async (_ctx, account) =>
      account === funded
        ? 100n
        : fault === "unfunded-holds" && account === operatorAccount(2)
          ? 1n
          : 0n
    )
    const bonded = runner(ctx, all, "first-bonded")
    if (fault === "outsider-bond" || fault === "over-cap")
      await Assert.rejects(bonded)
    else await bonded()
    if (fault === "unfunded-holds") {
      // The settled check refuses an unfunded operator that holds LIQSOL.
      ctx.outputs.set(Constants.Plan.parkedRequest, 3)
      mock.method(WireSyndicationTool, "readBonds", async () => [])
      mock.method(SyndicationScenario, "readFees", async () => 0n)
      await Assert.rejects(runner(ctx, all, "operators-settled"), /unfunded/)
    }
  })
}

for (const liquidAtClaim of [60n, 100n]) {
  test(`a claim during the recovery snapshot rereads the liquid balance once: ${liquidAtClaim}`, async () => {
    const { ctx, all } = planned()
    let secondReads = 0,
      liquidReads = 0
    mock.method(WireSyndicationTool, "readRequest", async (_ctx, id) =>
      id === 1
        ? firstApproved
        : {
            id: 2,
            bonded_at: "2026-10-14T00:04:15.000"
          }
    )
    mock.method(WireSyndicationTool, "readBonds", async (_ctx, id) => [
      {
        underwriter: funded,
        amount: "40",
        paid: id === 1 || secondReads++ > 0
      }
    ])
    mock.method(SyndicationScenario, "readBalance", async () =>
      liquidReads++ === 0 ? liquidAtClaim : 100n
    )
    await runner(ctx, all, "second-bonded-after-recovery")()
    Assert.equal(secondReads, 2)
    Assert.equal(liquidReads, 2)
  })
}
