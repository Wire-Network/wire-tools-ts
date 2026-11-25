const Assert = require("node:assert/strict")
const { test, describe, afterEach, mock } = require("node:test")

const { SlugName, SysioContracts } = require("@wireio/sdk-core")
const { OutpostChainCodename } = require("@wireio/cluster-tool-shared")
const {
  OutputStore,
  ProtocolTiming,
  Steps,
  WireCollateralTool,
  WireEconomicClockTool
} = require("@wireio/cluster-tool")
const StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js")

const { PerChainEpochsSteps } = require("../lib/steps/PerChainEpochsSteps.js")
const {
  PerChainEpochsScenarioConstants: Constants
} = require("../lib/PerChainEpochsScenarioConstants.js")

const { SysioOpregChainServiceStatus: ServiceStatus } = SysioContracts,
  signal = new AbortController().signal

afterEach(() => mock.restoreAll())

/** The fixture grid: each chain's genesis, and its duration. */
const GenesisMs = Date.UTC(2026, 10, 24, 0, 0, 0),
  EthereumSec = Constants.EthereumEpochDurationSec,
  SolanaSec = Constants.SolanaEpochDurationSec,
  EconomicSec = Constants.EconomicEpochDurationSec,
  Durations = { [OutpostChainCodename.ETHEREUM]: EthereumSec, [OutpostChainCodename.SOLANA]: SolanaSec },
  Config = { outpostEpochDurationSec: Durations, economicEpochDurationSec: EconomicSec },
  LagMs = 4_000,
  Operator = Constants.ServingOperatorLabel

/** A chain stamp (zone-less UTC) for epoch ms, as the RPC renders it. */
function stamp(ms) {
  return new Date(ms).toISOString().replace("Z", "")
}

/**
 * One idle chain's consensus reading at epoch `index` of a `durationSec` chain kept due, its
 * epochs started exactly one minimum apart (the closest depot pacing allows).
 */
function consensusReading(index, durationSec, paused = false) {
  const startMs = GenesisMs + (index - 1) * durationSec * 1_000
  return { epochIndex: index, epochStartMs: startMs, trafficSinceMs: 0, dueAtMs: 0, paused }
}

/** A clock reading at `headMs`, each chain at its index; `paused` pauses Ethereum. */
function reading(headMs, ethereum, solana, paused = false) {
  return {
    economicEpochIndex: 1,
    economicEpochStartMs: GenesisMs,
    economicNextEpochStartMs: GenesisMs + EconomicSec * 1_000,
    consensus: {
      [OutpostChainCodename.ETHEREUM]: consensusReading(ethereum, EthereumSec, paused),
      [OutpostChainCodename.SOLANA]: consensusReading(solana, SolanaSec)
    },
    headBlockTimeMs: headMs
  }
}

/** The reading of each chain's epoch at `headMs`, kept due and advancing one block of lag after each minimum. */
function onTime(headMs) {
  return reading(
    headMs,
    Math.floor((headMs - LagMs - GenesisMs) / (EthereumSec * 1_000)) + 1,
    Math.floor((headMs - LagMs - GenesisMs) / (SolanaSec * 1_000)) + 1
  )
}

/** A recorded observation of one reading. */
function observation(value) {
  return { start: value, ticks: [] }
}

/** A zero `time_point` as the RPC renders it: no traffic. */
const NoTraffic = "1970-01-01T00:00:00.000"

/** An idle `epochstate` row as the RPC renders it: a packed uint64 code, chain-time stamps. */
function epochStateRow(chain, index, durationSec, groups = [["batchop.a"]], cursor = 0) {
  const startMs = GenesisMs + (index - 1) * durationSec * 1_000
  return {
    chain_code: String(SlugName.from(chain)),
    current_epoch_index: index,
    current_epoch_start: stamp(startMs),
    traffic_since: NoTraffic,
    due_at: NoTraffic,
    current_batch_op_group: cursor,
    batch_op_groups: groups,
    is_paused: false
  }
}

/** Both chains' `epochstate` rows on the fixture grid. */
function epochStates(ethereum = 4, solana = 2) {
  return {
    [OutpostChainCodename.ETHEREUM]: epochStateRow(OutpostChainCodename.ETHEREUM, ethereum, EthereumSec),
    [OutpostChainCodename.SOLANA]: epochStateRow(OutpostChainCodename.SOLANA, solana, SolanaSec)
  }
}

/** Both chains' `epochcfg` rows at `durations`. */
function epochConfigs(durations = Durations) {
  return {
    [OutpostChainCodename.ETHEREUM]: { epoch_duration_sec: durations[OutpostChainCodename.ETHEREUM] },
    [OutpostChainCodename.SOLANA]: { epoch_duration_sec: durations[OutpostChainCodename.SOLANA] }
  }
}

/** A `servchains` row. */
function membership(account, chain, status, reason = "") {
  return {
    account,
    chain_code: chain,
    status,
    joined_at_ms: "1",
    updated_at_ms: "1",
    status_reason: reason
  }
}

/** A `wtdwqueue` row waiting on `waits`. */
function request(waits, id = 3) {
  return {
    request_id: String(id),
    account: Constants.WithdrawerLabel,
    chain_code: "WIRE",
    token_code: "WIRE",
    amount: Constants.WithdrawAmount.toString(),
    eligible_at_economic_epoch: 9,
    consensus_waits: waits,
    requested_at_economic_epoch: 7
  }
}

/** A build context over the fixture config, resolving every label to `account`. */
function context(outputs = new OutputStore(), extra = {}, account = Operator) {
  return {
    config: Config,
    keyStore: { assertOperator: () => ({ account }) },
    outputs,
    ...extra
  }
}

/** A `getInfo` whose head is at `headMs`. */
function wireAt(headMs) {
  return { getInfo: async () => ({ head_block_time: stamp(headMs) }) }
}

/**
 * Make every poll evaluate its read once: a read that holds returns, one that does not fails
 * with the poll's label — so a failure path is driven without waiting out a deadline.
 */
function pollOnce() {
  mock.method(StepTools, "pollUntil", async (label, predicate) => {
    Assert.ok(await predicate(), `Timed out waiting for: ${label}`)
  })
  mock.method(StepTools, "pollFor", async (label, read) => {
    const value = await read()
    Assert.ok(value != null, `Timed out waiting for: ${label}`)
    return value
  })
}

/** Make every poll read until its condition holds, without sleeping between reads. */
function pollImmediately() {
  mock.method(StepTools, "pollUntil", async (_label, predicate) => {
    while (!(await predicate()));
  })
}

/**
 * Record the keep-due pump: every chain's `epochstate` idle at `states`, each governance
 * `notetraffic` captured rather than pushed.
 *
 * @return The chains the pump resent the roster to, in push order.
 */
function recordPump(states = epochStates()) {
  mock.method(Steps.contracts.sysio.epoch, "readEpochStates", async () => states)
  const push = mock.method(Steps.contracts.sysio.epoch, "runNotetraffic", async () => undefined)
  return () => push.mock.calls.map(call => call.arguments[1].data.chain_code)
}

/** A seating input for the operator on `chain`. */
function seating(chain, budgetEpochs = 1) {
  return { kind: "PerChainEpochsSteps.SeatingInput", label: Operator, chain, budgetEpochs }
}

describe("budgets", () => {
  test("a chain's budget is its effective epochs at its own configured duration", () => {
    Assert.equal(
      PerChainEpochsSteps.chainEpochsBudgetMs(Config, OutpostChainCodename.SOLANA, 2),
      2 * (SolanaSec + ProtocolTiming.EpochExtensionMaxSec) * 1_000
    )
    Assert.notEqual(
      PerChainEpochsSteps.chainEpochsBudgetMs(Config, OutpostChainCodename.ETHEREUM, 2),
      PerChainEpochsSteps.chainEpochsBudgetMs(Config, OutpostChainCodename.SOLANA, 2)
    )
  })

  test("the window deadline is the window plus one delivery extension", () => {
    Assert.equal(
      PerChainEpochsSteps.windowDeadlineMs(Constants.PacingWindowSec),
      (Constants.PacingWindowSec + ProtocolTiming.EpochExtensionMaxSec) * 1_000
    )
  })

  test("a seat-seconds deadline adds the book-closing advance and the open pay period's close to the chain's rotation", () => {
    Assert.equal(
      PerChainEpochsSteps.seatSecondsDeadlineMs(Config, OutpostChainCodename.ETHEREUM, 4),
      (4 + Constants.BookClosingEpochs) * (EthereumSec + ProtocolTiming.EpochExtensionMaxSec) * 1_000 +
        Constants.DutyPeriodEconomicEpochs * (EconomicSec + ProtocolTiming.EpochExtensionMaxSec) * 1_000
    )
    Assert.equal(Constants.BookClosingEpochs, 1)
  })
})

describe("epoch durations", () => {
  test("every chain's duration comes from one epochcfg read", async () => {
    const read = mock.method(Steps.contracts.sysio.epoch, "readEpochConfigs", async () => epochConfigs())
    Assert.deepEqual(await PerChainEpochsSteps.readEpochDurations(context()), Durations)
    Assert.equal(read.mock.callCount(), 1)
  })

  test("a chain without an epochcfg row fails", async () => {
    mock.method(Steps.contracts.sysio.epoch, "readEpochConfigs", async () => ({
      [OutpostChainCodename.ETHEREUM]: { epoch_duration_sec: EthereumSec }
    }))
    await Assert.rejects(PerChainEpochsSteps.readEpochDurations(context()), /epochcfg has no SOLANA row/)
  })
})

describe("epoch configuration", () => {
  const { consensus } = reading(GenesisMs, 4, 2)

  test("each chain at its configured, distinct duration passes", () => {
    PerChainEpochsSteps.assertEpochConfiguration(Durations, consensus, Durations)
  })

  test("a chain at another duration fails", () => {
    Assert.throws(
      () =>
        PerChainEpochsSteps.assertEpochConfiguration(
          { ...Durations, [OutpostChainCodename.SOLANA]: EthereumSec },
          consensus,
          Durations
        ),
      /SOLANA epochcfg runs 60 s epochs, not the configured 150 s/
    )
  })

  test("a chain due one minimum after the later of its start and its traffic passes", () => {
    const ethereum = consensus[OutpostChainCodename.ETHEREUM],
      startMs = ethereum.epochStartMs
    // Traffic before the start: due one minimum after the start.
    PerChainEpochsSteps.assertDueAt(
      { ...ethereum, trafficSinceMs: startMs - 5_000, dueAtMs: startMs + EthereumSec * 1_000 },
      EthereumSec,
      OutpostChainCodename.ETHEREUM
    )
    // Traffic after the start: due one minimum after the traffic.
    PerChainEpochsSteps.assertDueAt(
      { ...ethereum, trafficSinceMs: startMs + 7_000, dueAtMs: startMs + 7_000 + EthereumSec * 1_000 },
      EthereumSec,
      OutpostChainCodename.ETHEREUM
    )
    // Idle: neither traffic nor due.
    PerChainEpochsSteps.assertDueAt(ethereum, EthereumSec, OutpostChainCodename.ETHEREUM)
  })

  test("a due_at off the minimum fails, in the configuration check too", () => {
    const ethereum = consensus[OutpostChainCodename.ETHEREUM],
      early = { ...ethereum, trafficSinceMs: ethereum.epochStartMs + 7_000, dueAtMs: ethereum.epochStartMs + EthereumSec * 1_000 }
    Assert.throws(
      () => PerChainEpochsSteps.assertDueAt(early, EthereumSec, OutpostChainCodename.ETHEREUM),
      /ETHEREUM epoch 4 is not due one 60 s minimum after the later of its start and its traffic/
    )
    Assert.throws(
      () =>
        PerChainEpochsSteps.assertEpochConfiguration(
          Durations,
          { ...consensus, [OutpostChainCodename.ETHEREUM]: early },
          Durations
        ),
      /is not due one 60 s minimum/
    )
  })

  test("an idle chain carrying a due_at fails", () => {
    const ethereum = consensus[OutpostChainCodename.ETHEREUM]
    Assert.throws(
      () =>
        PerChainEpochsSteps.assertDueAt(
          { ...ethereum, dueAtMs: ethereum.epochStartMs + EthereumSec * 1_000 },
          EthereumSec,
          OutpostChainCodename.ETHEREUM
        ),
      /ETHEREUM epoch 4 has no traffic yet is due at/
    )
  })

  test("two chains at one duration fail", () => {
    const uniform = { [OutpostChainCodename.ETHEREUM]: EthereumSec, [OutpostChainCodename.SOLANA]: EthereumSec },
      uniformConsensus = {
        [OutpostChainCodename.ETHEREUM]: consensusReading(4, EthereumSec),
        [OutpostChainCodename.SOLANA]: consensusReading(4, EthereumSec)
      }
    Assert.throws(
      () => PerChainEpochsSteps.assertEpochConfiguration(uniform, uniformConsensus, uniform),
      /two outpost chains run one consensus epoch duration/
    )
  })

  /** Serve no accepted winner and no dispute, the reads beside `epochstate` in a consensus reading. */
  function noDecisions() {
    mock.method(Steps.contracts.sysio.msgch, "readOutpostConsensus", async () => ({}))
    mock.method(Steps.contracts.sysio.chalg, "readEpochDispute", async () => undefined)
  }

  test("the verify step reads epochcfg and epochstate and asserts them against the configured durations", async () => {
    mock.method(Steps.contracts.sysio.epoch, "readEpochConfigs", async () => epochConfigs())
    mock.method(Steps.contracts.sysio.epoch, "readEpochStates", async () => epochStates())
    noDecisions()
    const step = PerChainEpochsSteps.planVerifyEpochConfiguration("Sysio", "configuration", "probe", {}, Durations)
    Assert.equal(step.runner, PerChainEpochsSteps.runVerifyEpochConfiguration)
    await PerChainEpochsSteps.runVerifyEpochConfiguration(context(), step.input, signal)
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyEpochConfiguration(
        context(),
        { ...step.input, durations: { ...Durations, [OutpostChainCodename.ETHEREUM]: SolanaSec } },
        signal
      ),
      /ETHEREUM epochcfg runs 60 s epochs, not the configured 150 s/
    )
  })

  test("the verify step refuses a chain without an epochstate row", async () => {
    mock.method(Steps.contracts.sysio.epoch, "readEpochConfigs", async () => epochConfigs())
    mock.method(Steps.contracts.sysio.epoch, "readEpochStates", async () => ({
      [OutpostChainCodename.ETHEREUM]: epochStateRow(OutpostChainCodename.ETHEREUM, 4, EthereumSec)
    }))
    noDecisions()
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyEpochConfiguration(
        context(),
        { kind: "PerChainEpochsSteps.VerifyEpochConfigurationInput", durations: Durations },
        signal
      ),
      /epochstate has no SOLANA row/
    )
  })
})

describe("pacing window", () => {
  const startName = Constants.PacingStartObservation,
    windowSec = Constants.PacingWindowSec,
    input = { kind: "PerChainEpochsSteps.AwaitWindowElapsedInput", fromObservationName: startName, windowSec }

  /** A context holding the window's starting reading at the fixture genesis, the head at `headMs`. */
  function windowContext(headMs) {
    return context(
      new OutputStore().set(WireEconomicClockTool.observationKey(startName), observation(reading(GenesisMs, 1, 1))),
      { wire: wireAt(headMs) }
    )
  }

  test("the await names the reading and the window it waits out", () => {
    const step = PerChainEpochsSteps.planAwaitWindowElapsed("Sysio", "window", "probe", {}, startName, windowSec)
    Assert.deepEqual(step.input, input)
    Assert.equal(step.runner, PerChainEpochsSteps.runAwaitWindowElapsed)
  })

  test("the await returns once the depot head is the window past the starting reading, adding no traffic", async () => {
    const pumped = recordPump()
    await PerChainEpochsSteps.runAwaitWindowElapsed(windowContext(GenesisMs + windowSec * 1_000), input, signal)
    Assert.deepEqual(pumped(), [])
  })

  test("a head short of the window's end keeps the await waiting and every idle chain due", async () => {
    pollOnce()
    const pumped = recordPump()
    await Assert.rejects(
      PerChainEpochsSteps.runAwaitWindowElapsed(windowContext(GenesisMs + windowSec * 1_000 - 1), input, signal),
      /Timed out waiting for: the depot head passes/
    )
    Assert.deepEqual(pumped(), [OutpostChainCodename.ETHEREUM, OutpostChainCodename.SOLANA])
  })

  test("an unrecorded starting reading fails", async () => {
    await Assert.rejects(
      PerChainEpochsSteps.runAwaitWindowElapsed(
        context(new OutputStore(), { wire: wireAt(GenesisMs) }),
        { ...input, fromObservationName: "never" },
        signal
      )
    )
  })
})

describe("own minimum", () => {
  const fromMs = GenesisMs + 10 * EthereumSec * 1_000 + LagMs,
    toMs = fromMs + Constants.PacingWindowSec * 1_000

  test("each chain advancing within its bounds, the faster one more, passes", () => {
    const advanced = PerChainEpochsSteps.assertOwnMinimum(onTime(fromMs), onTime(toMs), Durations)
    Assert.equal(advanced[OutpostChainCodename.ETHEREUM], Constants.PacingWindowSec / EthereumSec)
    Assert.ok(advanced[OutpostChainCodename.ETHEREUM] > advanced[OutpostChainCodename.SOLANA])
  })

  test("epochs that started more than a minimum apart pass: there is no grid", () => {
    const to = onTime(toMs),
      solana = to.consensus[OutpostChainCodename.SOLANA],
      late = {
        ...to,
        consensus: { ...to.consensus, [OutpostChainCodename.SOLANA]: { ...solana, epochStartMs: solana.epochStartMs + 1_000 } }
      }
    PerChainEpochsSteps.assertOwnMinimum(onTime(fromMs), late, Durations)
  })

  test("the window leaves Ethereum's kept-due bound two epochs under its worst real count", () => {
    // A kept-due 60 s epoch really closes within 73 s: the pump's latency, the relay's chkcons poll and a block.
    const window = Constants.PacingWindowSec,
      keptDueCycleSec = 73,
      bound = Math.floor(window / ProtocolTiming.effectiveEpochSec(EthereumSec))
    Assert.equal(window, 840)
    Assert.ok(Math.floor(window / keptDueCycleSec) - bound >= 2)
    Assert.ok(window / keptDueCycleSec - window / ProtocolTiming.effectiveEpochSec(EthereumSec) >= 2)
  })

  test("the window separates the chains on any run: the fast floor exceeds the slow ceiling", () => {
    const window = Constants.PacingWindowSec,
      fastFloor = Math.floor(window / (EthereumSec + ProtocolTiming.EpochExtensionMaxSec)),
      slowCeiling = Math.floor(window / SolanaSec) + 1
    Assert.ok(fastFloor > slowCeiling, `${fastFloor} <= ${slowCeiling}`)
  })

  test("epochs that started closer than one minimum apart fail", () => {
    const to = onTime(toMs),
      solana = to.consensus[OutpostChainCodename.SOLANA],
      early = {
        ...to,
        consensus: { ...to.consensus, [OutpostChainCodename.SOLANA]: { ...solana, epochStartMs: solana.epochStartMs - 1_000 } }
      }
    Assert.throws(
      () => PerChainEpochsSteps.assertOwnMinimum(onTime(fromMs), early, Durations),
      /SOLANA epochs \d+\.\.\d+ started less than 150 s apart/
    )
  })

  test("a paused chain fails", () => {
    const to = onTime(toMs),
      paused = reading(
        toMs,
        to.consensus[OutpostChainCodename.ETHEREUM].epochIndex,
        to.consensus[OutpostChainCodename.SOLANA].epochIndex,
        true
      )
    Assert.throws(
      () => PerChainEpochsSteps.assertOwnMinimum(onTime(fromMs), paused, Durations),
      /ETHEREUM consensus was paused/
    )
  })

  test("a chain kept due that advanced too few epochs fails", () => {
    const from = onTime(fromMs),
      to = onTime(toMs),
      behind = reading(
        toMs,
        from.consensus[OutpostChainCodename.ETHEREUM].epochIndex + 1,
        to.consensus[OutpostChainCodename.SOLANA].epochIndex
      )
    Assert.throws(
      () => PerChainEpochsSteps.assertOwnMinimum(from, behind, Durations),
      /ETHEREUM consensus advanced 1 epoch\(s\) in \d+ ms; kept due, its epoch closes within 90 s, so at least \d+/
    )
  })

  test("a chain that advanced faster than its minimum allows fails", () => {
    const from = onTime(fromMs),
      to = onTime(toMs),
      ceiling = Math.floor(Constants.PacingWindowSec / SolanaSec) + 1,
      rushed = reading(
        toMs,
        to.consensus[OutpostChainCodename.ETHEREUM].epochIndex,
        from.consensus[OutpostChainCodename.SOLANA].epochIndex + ceiling + 1
      )
    Assert.throws(
      () => PerChainEpochsSteps.assertOwnMinimum(from, rushed, Durations),
      new RegExp(`SOLANA consensus advanced ${ceiling + 1} epoch\\(s\\) in \\d+ ms; its minimum of 150 s allows at most ${ceiling}`)
    )
  })

  test("a faster chain that does not out-advance a slower one fails", () => {
    // Over 300 s both chains can close 3 epochs inside their bounds (Ethereum at least 3, Solana at most 3).
    const windowMs = 300_000,
      from = onTime(fromMs),
      matched = reading(
        fromMs + windowMs,
        from.consensus[OutpostChainCodename.ETHEREUM].epochIndex + 3,
        from.consensus[OutpostChainCodename.SOLANA].epochIndex + 3
      )
    Assert.throws(
      () => PerChainEpochsSteps.assertOwnMinimum(from, matched, Durations),
      /no more than the 150 s SOLANA epoch's/
    )
  })

  test("a window shorter than one effective epoch measures nothing", () => {
    Assert.throws(
      () => PerChainEpochsSteps.assertOwnMinimum(onTime(fromMs), onTime(fromMs + 1_000), Durations),
      /spans no whole/
    )
  })

  test("the verify step asserts the two stored readings against the depot's minimums", async () => {
    mock.method(Steps.contracts.sysio.epoch, "readEpochConfigs", async () => epochConfigs())
    const outputs = new OutputStore()
        .set(WireEconomicClockTool.observationKey("from"), observation(onTime(fromMs)))
        .set(WireEconomicClockTool.observationKey("to"), observation(onTime(toMs)))
        .set(WireEconomicClockTool.observationKey("paused"), observation(reading(toMs, 30, 10, true))),
      step = PerChainEpochsSteps.planVerifyOwnMinimum("Sysio", "minimum", "probe", {}, "from", "to")
    Assert.deepEqual(step.input, {
      kind: "PerChainEpochsSteps.VerifyOwnMinimumInput",
      fromObservationName: "from",
      toObservationName: "to"
    })
    Assert.equal(step.runner, PerChainEpochsSteps.runVerifyOwnMinimum)
    await PerChainEpochsSteps.runVerifyOwnMinimum(context(outputs), step.input, signal)
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyOwnMinimum(context(outputs), { ...step.input, toObservationName: "paused" }, signal),
      /ETHEREUM consensus was paused/
    )
  })
})

describe("consensus advance", () => {
  const input = {
    kind: "PerChainEpochsSteps.AwaitConsensusAdvancedInput",
    chain: OutpostChainCodename.ETHEREUM,
    count: 1,
    budgetEpochs: 3
  }

  test("the factory carries the chain, the count and the budget", () => {
    const step = PerChainEpochsSteps.planAwaitConsensusAdvanced("Sysio", "resumes", "probe", {}, OutpostChainCodename.ETHEREUM, 1, 3)
    Assert.deepEqual(step.input, input)
    Assert.equal(step.runner, PerChainEpochsSteps.runAwaitConsensusAdvanced)
  })

  test("the await returns once the chain moved the count past its starting index", async () => {
    const indices = [5, 5, 6],
      read = mock.method(Steps.contracts.sysio.epoch, "readCurrentEpochIndex", async (_ctx, chain) => {
        Assert.equal(chain, OutpostChainCodename.ETHEREUM)
        return indices.shift()
      })
    pollImmediately()
    await PerChainEpochsSteps.runAwaitConsensusAdvanced(context(), input, signal)
    Assert.equal(read.mock.callCount(), 3)
  })

  test("a chain that stays put keeps the await waiting and keeps that chain alone due", async () => {
    pollOnce()
    const pumped = recordPump()
    mock.method(Steps.contracts.sysio.epoch, "readCurrentEpochIndex", async () => 5)
    await Assert.rejects(
      PerChainEpochsSteps.runAwaitConsensusAdvanced(context(), input, signal),
      /the ETHEREUM consensus advances 1 epoch\(s\) past 5/
    )
    Assert.deepEqual(pumped(), [OutpostChainCodename.ETHEREUM])
  })
})

describe("memberships", () => {
  const account = Operator

  test("the expected statuses, by name or by value, pass", () => {
    PerChainEpochsSteps.assertMemberships(
      [
        membership(account, OutpostChainCodename.ETHEREUM, "LEFT"),
        membership(account, OutpostChainCodename.SOLANA, ServiceStatus.SERVING),
        membership("other", OutpostChainCodename.ETHEREUM, "EVICTED", "missed")
      ],
      account,
      { [OutpostChainCodename.ETHEREUM]: ServiceStatus.LEFT, [OutpostChainCodename.SOLANA]: ServiceStatus.SERVING }
    )
  })

  test("a chain not named must have no row", () => {
    Assert.throws(
      () =>
        PerChainEpochsSteps.assertMemberships(
          [membership(account, OutpostChainCodename.ETHEREUM, "SERVING"), membership(account, OutpostChainCodename.SOLANA, "SERVING")],
          account,
          { [OutpostChainCodename.ETHEREUM]: ServiceStatus.SERVING }
        ),
      /has a SOLANA membership/
    )
  })

  test("a wrong status, a missing row and an unexplained reason fail", () => {
    Assert.throws(
      () =>
        PerChainEpochsSteps.assertMemberships([membership(account, OutpostChainCodename.ETHEREUM, "LEFT")], account, {
          [OutpostChainCodename.ETHEREUM]: ServiceStatus.SERVING
        }),
      /ETHEREUM membership is LEFT, not SERVING/
    )
    Assert.throws(
      () => PerChainEpochsSteps.assertMemberships([], account, { [OutpostChainCodename.ETHEREUM]: ServiceStatus.SERVING }),
      /has no ETHEREUM membership/
    )
    Assert.throws(
      () =>
        PerChainEpochsSteps.assertMemberships(
          [membership(account, OutpostChainCodename.ETHEREUM, "SERVING", "stale")],
          account,
          { [OutpostChainCodename.ETHEREUM]: ServiceStatus.SERVING }
        ),
      /carries a status reason/
    )
  })

  test("another operator's row is not the operator's membership", () => {
    Assert.throws(
      () =>
        PerChainEpochsSteps.assertMemberships([membership("other", OutpostChainCodename.ETHEREUM, "SERVING")], account, {
          [OutpostChainCodename.ETHEREUM]: ServiceStatus.SERVING
        }),
      /has no ETHEREUM membership/
    )
  })

  test("the verify step reads every row and resolves the account by label", async () => {
    mock.method(Steps.contracts.sysio.opreg, "readServedChains", async () => [
      membership(account, OutpostChainCodename.ETHEREUM, "SERVING")
    ])
    const step = PerChainEpochsSteps.planVerifyMemberships("Sysio", "memberships", "probe", {}, account, {
      [OutpostChainCodename.ETHEREUM]: ServiceStatus.SERVING
    })
    Assert.equal(step.runner, PerChainEpochsSteps.runVerifyMemberships)
    await PerChainEpochsSteps.runVerifyMemberships(context(), step.input, signal)
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyMemberships(
        context(),
        { ...step.input, expected: { [OutpostChainCodename.SOLANA]: ServiceStatus.SERVING } },
        signal
      ),
      /has a ETHEREUM membership \(SERVING\); it never joined the chain/
    )
  })
})

describe("seating", () => {
  /** Serve `groups` as the chain's window on every read. */
  function windowOf(groups) {
    return mock.method(Steps.contracts.sysio.epoch, "readEpochState", async (_ctx, chain) =>
      epochStateRow(chain, 10, Durations[chain], groups)
    )
  }

  test("every seating factory builds the same input over its own runner", () => {
    const cases = [
      [PerChainEpochsSteps.planAwaitOperatorSeated, PerChainEpochsSteps.runAwaitOperatorSeated, 5],
      [PerChainEpochsSteps.planAwaitOperatorUnseated, PerChainEpochsSteps.runAwaitOperatorUnseated, 4],
      [PerChainEpochsSteps.planVerifyUnseatedForRotation, PerChainEpochsSteps.runVerifyUnseatedForRotation, 4]
    ]
    cases.forEach(([plan, runner, budget]) => {
      const step = plan("Sysio", "seating", "probe", {}, Operator, OutpostChainCodename.SOLANA, budget)
      Assert.deepEqual(step.input, seating(OutpostChainCodename.SOLANA, budget))
      Assert.equal(step.runner, runner)
    })
    const single = PerChainEpochsSteps.planVerifyOperatorUnseated("Sysio", "unseated", "probe", {}, Operator, OutpostChainCodename.SOLANA)
    Assert.deepEqual(single.input, seating(OutpostChainCodename.SOLANA, 0))
    Assert.equal(single.runner, PerChainEpochsSteps.runVerifyOperatorUnseated)
  })

  test("the seated await returns once a group of the chain's window seats the operator", async () => {
    const read = windowOf([["x"], ["y", Operator]])
    await PerChainEpochsSteps.runAwaitOperatorSeated(context(), seating(OutpostChainCodename.ETHEREUM), signal)
    Assert.equal(read.mock.calls[0].arguments[1], OutpostChainCodename.ETHEREUM)
  })

  test("a window that never seats the operator keeps the seated await waiting and its chain due", async () => {
    pollOnce()
    const pumped = recordPump()
    windowOf([["x"], ["y"]])
    await Assert.rejects(
      PerChainEpochsSteps.runAwaitOperatorSeated(context(), seating(OutpostChainCodename.ETHEREUM), signal),
      /the ETHEREUM schedule window seats chainop/
    )
    Assert.deepEqual(pumped(), [OutpostChainCodename.ETHEREUM])
  })

  test("the unseated await returns once no group seats the operator", async () => {
    windowOf([["x"], ["y"]])
    await PerChainEpochsSteps.runAwaitOperatorUnseated(context(), seating(OutpostChainCodename.ETHEREUM), signal)
  })

  test("a group still seating the operator keeps the unseated await waiting", async () => {
    pollOnce()
    windowOf([[Operator], ["y"]])
    await Assert.rejects(
      PerChainEpochsSteps.runAwaitOperatorUnseated(context(), seating(OutpostChainCodename.ETHEREUM), signal),
      /the ETHEREUM schedule window no longer seats chainop/
    )
  })

  test("the unseated verify reads the window once", async () => {
    const read = windowOf([["x"], ["y"]])
    await PerChainEpochsSteps.runVerifyOperatorUnseated(context(), seating(OutpostChainCodename.SOLANA, 0), signal)
    Assert.equal(read.mock.callCount(), 1)
  })

  test("the unseated verify fails when a group seats the operator", async () => {
    windowOf([["x"], [Operator]])
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyOperatorUnseated(context(), seating(OutpostChainCodename.SOLANA, 0), signal),
      /the SOLANA schedule window seats chainop, which does not serve the chain/
    )
  })

  test("a chain without a schedule seats nobody", async () => {
    mock.method(Steps.contracts.sysio.epoch, "readEpochState", async () => undefined)
    await PerChainEpochsSteps.runVerifyOperatorUnseated(context(), seating(OutpostChainCodename.SOLANA, 0), signal)
  })

  test("the rotation verify passes once the chain advanced its budget with the operator unseated", async () => {
    const indices = [10, 12, 14]
    windowOf([["x"], ["y"]])
    mock.method(Steps.contracts.sysio.epoch, "readCurrentEpochIndex", async () => indices.shift())
    pollImmediately()
    await PerChainEpochsSteps.runVerifyUnseatedForRotation(context(), seating(OutpostChainCodename.ETHEREUM, 4), signal)
    Assert.equal(indices.length, 0)
  })

  test("the rotation verify fails the moment a group seats the operator again", async () => {
    windowOf([["x"], [Operator]])
    mock.method(Steps.contracts.sysio.epoch, "readCurrentEpochIndex", async () => 10)
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyUnseatedForRotation(context(), seating(OutpostChainCodename.ETHEREUM, 4), signal),
      /the ETHEREUM schedule window seated chainop again after it left the chain/
    )
  })

  test("the rotation verify fails when the chain does not advance its budget, its chain kept due", async () => {
    pollOnce()
    const pumped = recordPump()
    windowOf([["x"], ["y"]])
    mock.method(Steps.contracts.sysio.epoch, "readCurrentEpochIndex", async () => 10)
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyUnseatedForRotation(context(), seating(OutpostChainCodename.ETHEREUM, 4), signal),
      /the ETHEREUM consensus advances 4 epoch\(s\) past 10 with chainop unseated/
    )
    Assert.deepEqual(pumped(), [OutpostChainCodename.ETHEREUM])
  })
})

describe("reseating", () => {
  const input = {
      kind: "PerChainEpochsSteps.AwaitOperatorReseatedInput",
      label: Operator,
      chain: OutpostChainCodename.SOLANA,
      sinceSnapshotName: Constants.LeaveSnapshot,
      budgetEpochs: 1
    },
    snapshot = { [OutpostChainCodename.ETHEREUM]: 20, [OutpostChainCodename.SOLANA]: 10 }

  /** A context holding the leave snapshot. */
  function reseatContext() {
    return context(new OutputStore().set(Steps.epochAdvance.epochIndicesKey(Constants.LeaveSnapshot), snapshot))
  }

  test("the factory names the snapshot the new seat must postdate", () => {
    const step = PerChainEpochsSteps.planAwaitOperatorReseated(
      "Sysio", "reseated", "probe", {}, Operator, OutpostChainCodename.SOLANA, Constants.LeaveSnapshot, 1
    )
    Assert.deepEqual(step.input, input)
    Assert.equal(step.runner, PerChainEpochsSteps.runAwaitOperatorReseated)
  })

  test("a seat resident at the snapshot is not a new seat", () => {
    const state = epochStateRow(OutpostChainCodename.SOLANA, 10, SolanaSec, [["x"], [Operator], ["y"]])
    Assert.equal(PerChainEpochsSteps.newSeatEpoch(state, Operator, 10), undefined)
  })

  test("a seat in a group appended after the snapshot names the epoch it serves", () => {
    const state = epochStateRow(OutpostChainCodename.SOLANA, 12, SolanaSec, [["x"], [Operator], ["y"]])
    Assert.equal(PerChainEpochsSteps.newSeatEpoch(state, Operator, 10), 13)
  })

  test("the cursor offsets the epoch each slot serves", () => {
    const state = epochStateRow(OutpostChainCodename.SOLANA, 12, SolanaSec, [[Operator], ["x"], ["y"]], 1)
    Assert.equal(PerChainEpochsSteps.newSeatEpoch(state, Operator, 7), 11)
    Assert.equal(PerChainEpochsSteps.newSeatEpoch(state, Operator, 9), undefined)
  })

  test("a chain without a schedule has no new seat", () => {
    Assert.equal(PerChainEpochsSteps.newSeatEpoch(undefined, Operator, 7), undefined)
  })

  test("the await resolves once a group appended after the snapshot seats the operator", async () => {
    const states = [
      epochStateRow(OutpostChainCodename.SOLANA, 10, SolanaSec, [[Operator], ["x"], ["y"]]),
      epochStateRow(OutpostChainCodename.SOLANA, 13, SolanaSec, [["x"], ["y"], [Operator]])
    ]
    mock.method(Steps.contracts.sysio.epoch, "readEpochState", async () => states.shift() ?? states[0])
    await PerChainEpochsSteps.runAwaitOperatorReseated(reseatContext(), input, signal)
    Assert.equal(states.length, 0)
  })

  test("a window that only holds the resident seat keeps the await waiting", async () => {
    pollOnce()
    mock.method(Steps.contracts.sysio.epoch, "readEpochState", async () =>
      epochStateRow(OutpostChainCodename.SOLANA, 10, SolanaSec, [[Operator], ["x"], ["y"]])
    )
    await Assert.rejects(
      PerChainEpochsSteps.runAwaitOperatorReseated(reseatContext(), input, signal),
      /a SOLANA group appended after epoch 10 seats chainop/
    )
  })

  test("an unrecorded snapshot fails", async () => {
    await Assert.rejects(PerChainEpochsSteps.runAwaitOperatorReseated(context(), input, signal))
  })
})

describe("duty periods", () => {
  /** A context whose `dutystate` read returns `rows`. */
  function dutyContext(rows) {
    return context(new OutputStore(), {
      wire: { getSysioContract: () => ({ tables: { dutystate: { query: async () => ({ rows }) } } }) }
    })
  }

  test("dutystate is read as its one row", async () => {
    Assert.deepEqual(await PerChainEpochsSteps.readDutyState(dutyContext([{ open_period: 4 }])), { open_period: 4 })
  })

  test("dutystate is absent before initt5", async () => {
    Assert.equal(await PerChainEpochsSteps.readDutyState(dutyContext([])), undefined)
  })

  test("the record step stores the open period under its name", async () => {
    const ctx = dutyContext([{ open_period: 4 }]),
      step = PerChainEpochsSteps.planRecordDutyPeriod("Sysio", "record", "probe", {}, Constants.SolanaOnlyDutyPeriod)
    Assert.equal(step.runner, PerChainEpochsSteps.runRecordDutyPeriod)
    await PerChainEpochsSteps.runRecordDutyPeriod(ctx, step.input, signal)
    Assert.equal(ctx.outputs.assert(PerChainEpochsSteps.dutyPeriodKey(Constants.SolanaOnlyDutyPeriod)), 4)
  })

  test("recording without a dutystate row fails", async () => {
    await Assert.rejects(
      PerChainEpochsSteps.runRecordDutyPeriod(
        dutyContext([]),
        { kind: "PerChainEpochsSteps.RecordDutyPeriodInput", periodName: "probe" },
        signal
      ),
      /dutystate has no row/
    )
  })
})

describe("seat-seconds", () => {
  /** A context whose `batchduty` read returns `rows`, with the Solana-only period recorded at 4. */
  function seatContext(rows) {
    return context(new OutputStore().set(PerChainEpochsSteps.dutyPeriodKey(Constants.SolanaOnlyDutyPeriod), 4), {
      wire: {
        getSysioContract: () => ({
          tables: { batchduty: { query: async () => ({ rows, more: false }) } }
        })
      }
    })
  }

  /** The await's input on `chain`, after `sincePeriodName` when given. */
  function accrual(chain, sincePeriodName) {
    return {
      kind: "PerChainEpochsSteps.AwaitSeatSecondsAccruedInput",
      label: Operator,
      chain,
      budgetEpochs: 1,
      sincePeriodName
    }
  }

  /** Answer each chain's epochcfg duration from the fixture durations. */
  function durationsRead() {
    mock.method(Steps.contracts.sysio.epoch, "readEpochDurationSec", async (_ctx, chain) => Durations[chain])
  }

  /** A `batchduty` row of `account` on `chain` in `period`, rendered as the RPC renders it. */
  function dutyRow(account, chain, period, seatSeconds) {
    return { account_name: account, chain_code: chain, period, seat_seconds: String(seatSeconds) }
  }

  test("seats times the chain's minimum passes and counts the seats", () => {
    Assert.equal(PerChainEpochsSteps.assertSeatSeconds(BigInt(3 * SolanaSec), SolanaSec, OutpostChainCodename.SOLANA), 3)
  })

  test("no seat-seconds fail", () => {
    Assert.throws(
      () => PerChainEpochsSteps.assertSeatSeconds(0n, EthereumSec, OutpostChainCodename.ETHEREUM),
      /no ETHEREUM seat-seconds accrued/
    )
  })

  test("a seat of the other chain breaks the multiple", () => {
    Assert.throws(
      () =>
        PerChainEpochsSteps.assertSeatSeconds(
          BigInt(2 * SolanaSec + EthereumSec),
          SolanaSec,
          OutpostChainCodename.SOLANA
        ),
      /are not a whole number of 150 s SOLANA seats/
    )
    Assert.throws(
      () => PerChainEpochsSteps.assertSeatSeconds(BigInt(SolanaSec), EthereumSec, OutpostChainCodename.ETHEREUM),
      /are not a whole number of 60 s ETHEREUM seats/
    )
  })

  test("the factory carries the budget, and the period only when one is named", () => {
    const after = PerChainEpochsSteps.planAwaitSeatSecondsAccrued(
        "Sysio", "duty", "probe", {}, Operator, OutpostChainCodename.SOLANA, 4, Constants.SolanaOnlyDutyPeriod
      ),
      any = PerChainEpochsSteps.planAwaitSeatSecondsAccrued("Sysio", "duty", "probe", {}, Operator, OutpostChainCodename.ETHEREUM, 4)
    Assert.equal(after.input.budgetEpochs, 4)
    Assert.equal(after.input.sincePeriodName, Constants.SolanaOnlyDutyPeriod)
    Assert.equal(any.input.sincePeriodName, undefined)
    Assert.equal(any.runner, PerChainEpochsSteps.runAwaitSeatSecondsAccrued)
  })

  test("the await takes the operator's row on the chain of a period after the recorded one", async () => {
    durationsRead()
    await PerChainEpochsSteps.runAwaitSeatSecondsAccrued(
      seatContext([
        dutyRow(Operator, OutpostChainCodename.ETHEREUM, 4, EthereumSec),
        dutyRow("other", OutpostChainCodename.ETHEREUM, 5, 7),
        dutyRow(Operator, OutpostChainCodename.SOLANA, 5, 2 * SolanaSec)
      ]),
      accrual(OutpostChainCodename.SOLANA, Constants.SolanaOnlyDutyPeriod),
      signal
    )
  })

  test("without a recorded period any accruing period counts", async () => {
    durationsRead()
    await PerChainEpochsSteps.runAwaitSeatSecondsAccrued(
      seatContext([dutyRow(Operator, OutpostChainCodename.ETHEREUM, 1, 3 * EthereumSec)]),
      accrual(OutpostChainCodename.ETHEREUM),
      signal
    )
  })

  test("a row only of the recorded period, one with no seat-seconds, or one of another chain keeps the await waiting", async () => {
    pollOnce()
    durationsRead()
    await Assert.rejects(
      PerChainEpochsSteps.runAwaitSeatSecondsAccrued(
        seatContext([
          dutyRow(Operator, OutpostChainCodename.SOLANA, 4, SolanaSec),
          dutyRow(Operator, OutpostChainCodename.SOLANA, 5, 0),
          dutyRow(Operator, OutpostChainCodename.ETHEREUM, 5, EthereumSec)
        ]),
        accrual(OutpostChainCodename.SOLANA, Constants.SolanaOnlyDutyPeriod),
        signal
      ),
      /chainop accrues SOLANA seat-seconds in a pay period after 4/
    )
  })

  test("seat-seconds of another chain in the same pay period fail", async () => {
    durationsRead()
    await Assert.rejects(
      PerChainEpochsSteps.runAwaitSeatSecondsAccrued(
        seatContext([
          dutyRow(Operator, OutpostChainCodename.SOLANA, 5, SolanaSec),
          dutyRow(Operator, OutpostChainCodename.ETHEREUM, 5, EthereumSec)
        ]),
        accrual(OutpostChainCodename.SOLANA, Constants.SolanaOnlyDutyPeriod),
        signal
      ),
      /chainop also accrued seat-seconds on ETHEREUM in pay period 5, not only on SOLANA/
    )
  })

  test("a chain's row that is not whole epochs of that chain fails", async () => {
    durationsRead()
    await Assert.rejects(
      PerChainEpochsSteps.runAwaitSeatSecondsAccrued(
        seatContext([dutyRow(Operator, OutpostChainCodename.SOLANA, 5, SolanaSec + EthereumSec)]),
        accrual(OutpostChainCodename.SOLANA, Constants.SolanaOnlyDutyPeriod),
        signal
      ),
      /are not a whole number of 150 s SOLANA seats/
    )
  })

  test("an accrual is the operator's row on the chain, of a later period, with seat-seconds", () => {
    const accrues = row => PerChainEpochsSteps.isSeatSecondsAccrual(row, Operator, OutpostChainCodename.SOLANA, 4)
    Assert.equal(accrues(dutyRow(Operator, OutpostChainCodename.SOLANA, 5, SolanaSec)), true)
    Assert.equal(accrues(dutyRow("other", OutpostChainCodename.SOLANA, 5, SolanaSec)), false)
    Assert.equal(accrues(dutyRow(Operator, OutpostChainCodename.ETHEREUM, 5, EthereumSec)), false)
    Assert.equal(accrues(dutyRow(Operator, OutpostChainCodename.SOLANA, 4, SolanaSec)), false)
    Assert.equal(accrues(dutyRow(Operator, OutpostChainCodename.SOLANA, 5, 0)), false)
  })

  test("another chain's duty of the operator counts only in the row's own period, and only with seat-seconds", () => {
    const row = dutyRow(Operator, OutpostChainCodename.SOLANA, 5, SolanaSec)
    Assert.doesNotThrow(() =>
      PerChainEpochsSteps.assertNoOtherChainDuty(
        [
          row,
          dutyRow(Operator, OutpostChainCodename.ETHEREUM, 4, EthereumSec),
          dutyRow(Operator, OutpostChainCodename.ETHEREUM, 5, 0),
          dutyRow("other", OutpostChainCodename.ETHEREUM, 5, EthereumSec)
        ],
        row,
        OutpostChainCodename.SOLANA
      )
    )
    Assert.throws(
      () =>
        PerChainEpochsSteps.assertNoOtherChainDuty(
          [row, dutyRow(Operator, OutpostChainCodename.ETHEREUM, 5, EthereumSec)],
          row,
          OutpostChainCodename.SOLANA
        ),
      /chainop also accrued seat-seconds on ETHEREUM in pay period 5/
    )
  })

  test("a period that was never recorded fails", async () => {
    durationsRead()
    await Assert.rejects(
      PerChainEpochsSteps.runAwaitSeatSecondsAccrued(seatContext([]), accrual(OutpostChainCodename.SOLANA, "never"), signal)
    )
  })

  test("batchduty is read whole", async () => {
    const rows = [dutyRow(Operator, OutpostChainCodename.ETHEREUM, 5, EthereumSec)]
    Assert.deepEqual(await PerChainEpochsSteps.readBatchDuty(seatContext(rows)), rows)
  })

  test("a truncated batchduty read is refused", async () => {
    const ctx = {
      wire: {
        getSysioContract: () => ({
          tables: { batchduty: { query: async () => ({ rows: [], more: true }) } }
        })
      }
    }
    await Assert.rejects(PerChainEpochsSteps.readBatchDuty(ctx), /the read is truncated/)
  })
})

describe("withdrawal waits", () => {
  const solanaWait = eligible => ({ chain_code: OutpostChainCodename.SOLANA, eligible_at_epoch: eligible }),
    before = { [OutpostChainCodename.ETHEREUM]: 30, [OutpostChainCodename.SOLANA]: 10 },
    input = {
      kind: "PerChainEpochsSteps.VerifyWithdrawalWaitsInput",
      label: Constants.WithdrawerLabel,
      chain: OutpostChainCodename.SOLANA,
      beforeSnapshotName: Constants.WithdrawalSnapshot
    }

  /** A context holding the pre-request snapshot, every chain's index now at `after`. */
  function withdrawalContext(after = before) {
    mock.method(Steps.contracts.sysio.epoch, "readCurrentEpochIndices", async () => after)
    return context(
      new OutputStore().set(Steps.epochAdvance.epochIndicesKey(Constants.WithdrawalSnapshot), before),
      {},
      Constants.WithdrawerLabel
    )
  }

  test("the factory names the operator, the chain and the snapshot", () => {
    const step = PerChainEpochsSteps.planVerifyWithdrawalWaits(
      "Sysio", "waits", "probe", {}, Constants.WithdrawerLabel, OutpostChainCodename.SOLANA, Constants.WithdrawalSnapshot
    )
    Assert.deepEqual(step.input, input)
    Assert.equal(step.runner, PerChainEpochsSteps.runVerifyWithdrawalWaits)
  })

  test("the newest request waiting on Solana alone, two epochs past the request, passes", async () => {
    mock.method(WireCollateralTool, "readWithdrawRequests", async () => [
      request([{ chain_code: OutpostChainCodename.ETHEREUM, eligible_at_epoch: 2 }], 1),
      request([solanaWait(10 + WireCollateralTool.WithdrawWaitConsensusEpochs)], 4)
    ])
    await PerChainEpochsSteps.runVerifyWithdrawalWaits(withdrawalContext(), input, signal)
  })

  test("a request between two Solana epochs may be guarded from either", async () => {
    mock.method(WireCollateralTool, "readWithdrawRequests", async () => [request([solanaWait(13)])])
    await PerChainEpochsSteps.runVerifyWithdrawalWaits(
      withdrawalContext({ ...before, [OutpostChainCodename.SOLANA]: 11 }),
      input,
      signal
    )
  })

  test("an operator with no queued withdrawal fails", async () => {
    mock.method(WireCollateralTool, "readWithdrawRequests", async () => [])
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyWithdrawalWaits(withdrawalContext(), input, signal),
      /solwithdraw has no queued withdrawal/
    )
  })

  test("a wait on both chains fails", async () => {
    mock.method(WireCollateralTool, "readWithdrawRequests", async () => [
      request([solanaWait(12), { chain_code: OutpostChainCodename.ETHEREUM, eligible_at_epoch: 32 }])
    ])
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyWithdrawalWaits(withdrawalContext(), input, signal),
      /waits on SOLANA, ETHEREUM, not on SOLANA/
    )
  })

  test("a wait on the other chain fails", async () => {
    mock.method(WireCollateralTool, "readWithdrawRequests", async () => [
      request([{ chain_code: OutpostChainCodename.ETHEREUM, eligible_at_epoch: 12 }])
    ])
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyWithdrawalWaits(withdrawalContext(), input, signal),
      /waits on ETHEREUM, not on SOLANA/
    )
  })

  test("a wait at another epoch fails", async () => {
    mock.method(WireCollateralTool, "readWithdrawRequests", async () => [request([solanaWait(11)])])
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyWithdrawalWaits(withdrawalContext(), input, signal),
      /waits for SOLANA epoch 11/
    )
  })

  test("an unrecorded snapshot fails", async () => {
    mock.method(WireCollateralTool, "readWithdrawRequests", async () => [request([solanaWait(12)])])
    mock.method(Steps.contracts.sysio.epoch, "readCurrentEpochIndices", async () => before)
    await Assert.rejects(
      PerChainEpochsSteps.runVerifyWithdrawalWaits(context(new OutputStore(), {}, Constants.WithdrawerLabel), input, signal)
    )
  })
})
