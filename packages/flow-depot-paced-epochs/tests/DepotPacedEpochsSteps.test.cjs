const Assert = require("node:assert/strict")
const { test, describe, afterEach, mock } = require("node:test")

const { SlugName, SysioContracts } = require("@wireio/sdk-core")
const { OutpostChainCodename } = require("@wireio/cluster-tool-shared")
const {
  EthereumFundingTool,
  EthereumRoundTripScenario,
  ManagedProcess,
  OutputStore,
  ProtocolTiming,
  SolanaOutpostProgramTool,
  SolanaOutpostTarget,
  Steps,
  WireEconomicClockTool,
  WireSyndicationTool
} = require("@wireio/cluster-tool")
const StepTools = require("@wireio/cluster-tool/lib/cjs/orchestration/StepTools.js")

const { DepotPacedEpochsSteps } = require("../lib/steps/DepotPacedEpochsSteps.js")
const {
  DepotPacedEpochsScenarioConstants: Constants
} = require("../lib/DepotPacedEpochsScenarioConstants.js")

const { SysioContractName, SysioMsgchChainkind, SysioSyndItemKind } = SysioContracts,
  signal = new AbortController().signal,
  Ethereum = OutpostChainCodename.ETHEREUM,
  Solana = OutpostChainCodename.SOLANA,
  Durations = { [Ethereum]: 60, [Solana]: 30 },
  Config = { outpostEpochDurationSec: Durations, economicEpochDurationSec: 120 },
  /** The fixture clock: every time is an offset from it. */
  BaseMs = Date.UTC(2026, 10, 25, 0, 0, 0),
  Member = "batchop.a",
  Group = [Member, "batchop.b", "batchop.c"],
  Winner = "aa".repeat(32),
  Other = "bb".repeat(32)

afterEach(() => mock.restoreAll())

/** A chain stamp (zone-less UTC) for epoch ms, as the RPC renders it. */
function stamp(ms) {
  return new Date(ms).toISOString().replace("Z", "")
}

/** One chain's consensus reading: idle and decided unless told otherwise. */
function consensus(epochIndex, overrides = {}) {
  return {
    epochIndex,
    epochStartMs: BaseMs,
    trafficSinceMs: 0,
    dueAtMs: 0,
    paused: false,
    decided: true,
    ...overrides
  }
}

/** Every chain's consensus reading. */
function readings(ethereum, solana) {
  return { [Ethereum]: ethereum, [Solana]: solana }
}

/** A clock reading at `headMs` and economic epoch `economicEpochIndex`. */
function clock(headMs, economicEpochIndex, ethereum = consensus(4), solana = consensus(2)) {
  return {
    economicEpochIndex,
    economicEpochStartMs: headMs,
    economicNextEpochStartMs: headMs + 120_000,
    consensus: readings(ethereum, solana),
    headBlockTimeMs: headMs
  }
}

/** An idle window: four readings, three economic epochs opened, 260 s apart end to end. */
function idleObservation(lastEthereum = consensus(4)) {
  return {
    start: clock(BaseMs, 5),
    ticks: [clock(BaseMs + 20_000, 6), clock(BaseMs + 140_000, 7), clock(BaseMs + 260_000, 8, lastEthereum)]
  }
}

/** A due observation of Ethereum epoch 4, its traffic since `trafficSinceMs`, due 30 s later. */
function dueObservation(trafficSinceMs = BaseMs + 100_000, observedAtMs = trafficSinceMs + 15_000) {
  return {
    reading: consensus(4, { trafficSinceMs, dueAtMs: trafficSinceMs + 30_000 }),
    observedAtMs,
    group: Group
  }
}

/** A `qreports` row: `account`'s backlog report of `chain` in `epochIndex`. */
function report(account, epochIndex = 4, oldestMs = BaseMs + 100_000, pending = 3, chain = Ethereum) {
  return {
    chain_code: String(SlugName.from(chain)),
    account,
    epoch_index: epochIndex,
    pending_count: pending,
    oldest_pending_at: stamp(oldestMs)
  }
}

/** An `envelopes` row: `account`'s delivery of `chain`'s `epochIndex`. */
function envelope(account, epochIndex, receivedMs, checksum = Winner, chain = Ethereum) {
  return {
    id: 1,
    chain_code: String(SlugName.from(chain)),
    epoch_index: epochIndex,
    batch_op_name: account,
    chain_kind: SysioMsgchChainkind.CHAIN_KIND_EVM,
    checksum,
    raw_data: "",
    received_at: stamp(receivedMs)
  }
}

/** An `envlog` row of `chain`'s `epochIndex`: inbound (outpost → depot) unless told otherwise. */
function envelopeLog(epochIndex, emittedMs, inbound = true, chain = Ethereum) {
  const outpost = { kind: "CHAIN_KIND_EVM", id: { value: 31337 } },
    depot = { kind: "CHAIN_KIND_WIRE", id: { value: 1 } }
  return {
    id: 1,
    chain_code: String(SlugName.from(chain)),
    chain_seq: 1,
    endpoints: inbound ? { start: outpost, end: depot } : { start: depot, end: outpost },
    epoch_index: epochIndex,
    checksum: Winner,
    emitted_at: stamp(emittedMs)
  }
}

/** A `dellog` row: `account`'s hit or miss of `chain`'s `epoch`. */
function delivery(account, epoch, delivered = true, chain = Ethereum) {
  return { log_id: 1, account, chain_code: chain, epoch, delivered, ts_ms: "1" }
}

/** An `epochstate` row: `chain` at `epochIndex`, its window `groups`, cursor `cursor`. */
function epochState(epochIndex, groups = [["batchop.d"], Group, ["batchop.g"]], cursor = 0, chain = Ethereum) {
  return {
    chain_code: String(SlugName.from(chain)),
    current_epoch_index: epochIndex,
    current_epoch_start: stamp(BaseMs),
    traffic_since: stamp(0),
    due_at: stamp(0),
    current_batch_op_group: cursor,
    batch_op_groups: groups,
    is_paused: false,
    previous_group: []
  }
}

/** An `outpcons` row recording the accepted winner of `chain`'s `epochIndex`. */
function outpostConsensus(epochIndex, winningChecksum = Winner, chain = Ethereum) {
  return {
    chain_code: String(SlugName.from(chain)),
    epoch_index: epochIndex,
    consensus_reached: true,
    winning_checksum: winningChecksum,
    envelope_digest: "",
    message_tip: "",
    previous_epoch_index: epochIndex - 1,
    previous_winning_checksum: Other
  }
}

/** A build context over the fixture config, resolving every label to `account`. */
function context(outputs = new OutputStore(), extra = {}, account = Member) {
  return { config: Config, keyStore: { assertOperator: () => ({ account }) }, outputs, ...extra }
}

/** A `ctx.wire` whose `getSysioContract(name).tables.<table>.queryAll()` returns `tables[table]`. */
function wireOf(tables, extra = {}) {
  return {
    getSysioContract: () => ({
      tables: Object.fromEntries(
        Object.entries(tables).map(([table, rows]) => [
          table,
          { queryAll: async () => rows, query: async () => ({ rows, more: false }) }
        ])
      )
    }),
    ...extra
  }
}

/** Make every poll evaluate its read once: one that holds returns, one that does not fails with the poll's label. */
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

/** Record the keep-due pump: every chain's `epochstate` at `states`, each `notetraffic` captured. */
function recordPump(states) {
  mock.method(Steps.contracts.sysio.epoch, "readEpochStates", async () => states)
  const push = mock.method(Steps.contracts.sysio.epoch, "runNotetraffic", async () => undefined)
  return () => push.mock.calls.map(call => call.arguments[1].data.chain_code)
}

describe("pure rules", () => {
  test("a strict majority is more than half of the seats", () => {
    Assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7].map(DepotPacedEpochsSteps.strictMajorityOf),
      [1, 2, 2, 3, 3, 4, 4]
    )
  })

  test("the idle window awaits enough economic epochs to span three of the longest minimum from any start", () => {
    const epochs = DepotPacedEpochsSteps.idleEconomicEpochs(Config)
    Assert.equal(epochs, 3)
    // n epochs opened span more than n - 1 economic durations.
    Assert.ok((epochs - 1) * Config.economicEpochDurationSec >= Constants.IdleWindowMinimums * Durations[Ethereum])
    Assert.equal(DepotPacedEpochsSteps.idleEconomicEpochs({ ...Config, economicEpochDurationSec: 60 }), 4)
  })

  test("the advance slack is one relay poll, its tick and two blocks", () => {
    Assert.equal(DepotPacedEpochsSteps.advanceSlackMs(60), 2_500 + 1_000 + 2 * ProtocolTiming.BlockIntervalMs)
    Assert.equal(DepotPacedEpochsSteps.advanceSlackMs(30), 1_250 + 1_000 + 2 * ProtocolTiming.BlockIntervalMs)
    // A poll never comes faster than a second.
    Assert.equal(DepotPacedEpochsSteps.advanceSlackMs(10), 1_000 + 1_000 + 2 * ProtocolTiming.BlockIntervalMs)
  })

  test("each chain's newest outbound envelope is its highest retained epoch, 0 without one", () => {
    const rows = [
      { chain_code: String(SlugName.from(Ethereum)), epoch_index: 5 },
      { chain_code: String(SlugName.from(Ethereum)), epoch_index: 7 },
      { chain_code: String(SlugName.from(Ethereum)), epoch_index: 6 }
    ]
    Assert.deepEqual(DepotPacedEpochsSteps.newestOutboundEpochs(rows), { [Ethereum]: 7, [Solana]: 0 })
    Assert.deepEqual(DepotPacedEpochsSteps.newestOutboundEpochs([]), { [Ethereum]: 0, [Solana]: 0 })
  })

  test("the next epoch's group sits one slot past the cursor", () => {
    Assert.deepEqual(DepotPacedEpochsSteps.nextOnDutyGroup(epochState(4)), Group)
    Assert.deepEqual(DepotPacedEpochsSteps.nextOnDutyGroup(epochState(4, [["x"], ["y"], Group], 1)), Group)
    Assert.equal(DepotPacedEpochsSteps.nextOnDutyGroup(epochState(4, [["x"], Group], 1)), undefined)
    Assert.equal(DepotPacedEpochsSteps.nextOnDutyGroup(undefined), undefined)
  })
})

describe("idle", () => {
  test("every chain idle, decided and still through the window passes and returns the span", () => {
    Assert.equal(DepotPacedEpochsSteps.assertIdleObservation(idleObservation(), Durations), 260_000)
  })

  test("a chain that moved, had traffic, was undecided or paused fails", () => {
    ;[
      [consensus(5), /the idle ETHEREUM chain moved from epoch 4 to 5/],
      [consensus(4, { trafficSinceMs: BaseMs, dueAtMs: BaseMs + 60_000 }), /the ETHEREUM chain had traffic/],
      [consensus(4, { decided: false }), /the ETHEREUM epoch 4 was undecided/],
      [consensus(4, { paused: true }), /the ETHEREUM chain was paused/]
    ].forEach(([last, message]) =>
      Assert.throws(() => DepotPacedEpochsSteps.assertIdleObservation(idleObservation(last), Durations), message)
    )
  })

  test("a window under three of the longest minimum, or with no economic epoch, fails", () => {
    const short = { start: clock(BaseMs, 5), ticks: [clock(BaseMs + 120_000, 6)] },
      frozen = { start: clock(BaseMs, 5), ticks: [clock(BaseMs + 200_000, 5)] }
    Assert.throws(() => DepotPacedEpochsSteps.assertIdleObservation(short, Durations), /the idle window spans 120000 ms, under 180000 ms/)
    Assert.throws(() => DepotPacedEpochsSteps.assertIdleObservation(frozen, Durations), /the economic clock stayed at epoch 5/)
  })

  test("unchanged streams pass; a new envelope or a moved outpost cursor fails", () => {
    const before = { outboundEpoch: { [Ethereum]: 4, [Solana]: 2 }, outpostCursor: { [Ethereum]: 5, [Solana]: 3 } }
    DepotPacedEpochsSteps.assertStreamsUnchanged(before, structuredClone(before))
    Assert.throws(
      () => DepotPacedEpochsSteps.assertStreamsUnchanged(before, { ...before, outboundEpoch: { [Ethereum]: 5, [Solana]: 2 } }),
      /the depot built a ETHEREUM envelope for epoch 5 while the chain was idle/
    )
    Assert.throws(
      () => DepotPacedEpochsSteps.assertStreamsUnchanged(before, { ...before, outpostCursor: { [Ethereum]: 5, [Solana]: 4 } }),
      /the SOLANA outpost's inbound cursor moved from 3 to 4/
    )
  })

  test("runRecordOppStreams stores the depot's newest envelopes and both outposts' cursors", async () => {
    mock.method(EthereumRoundTripScenario, "readInboundEpoch", async () => 5n)
    mock.method(SolanaOutpostTarget, "resolve", () => ({
      programId: "program",
      solanaPath: "/wire-solana",
      connection: { getAccountInfo: async () => ({ data: Buffer.from("config") }) }
    }))
    mock.method(SolanaOutpostProgramTool, "derivePda", () => ({ toBase58: () => "config-pda" }))
    const decode = mock.fn(() => ({ nextEpochIndex: 3 }))
    mock.method(SolanaOutpostProgramTool, "loadReadOnlyProgram", () => ({ coder: { accounts: { decode } } }))
    const ctx = context(new OutputStore(), {
      wire: wireOf({ outenvelopes: [{ chain_code: String(SlugName.from(Ethereum)), epoch_index: 4 }] })
    })
    await DepotPacedEpochsSteps.runRecordOppStreams(ctx, { kind: "DepotPacedEpochsSteps.RecordOppStreamsInput", snapshotName: "s" }, signal)
    Assert.deepEqual(ctx.outputs.assert(DepotPacedEpochsSteps.streamSnapshotKey("s")), {
      outboundEpoch: { [Ethereum]: 4, [Solana]: 0 },
      outpostCursor: { [Ethereum]: 5, [Solana]: 3 }
    })
    Assert.equal(decode.mock.calls[0].arguments[0], DepotPacedEpochsSteps.OutpostConfigAccountName)
  })

  test("a Solana outpost without an OutpostConfig fails the cursor read", async () => {
    mock.method(SolanaOutpostTarget, "resolve", () => ({
      programId: "program",
      connection: { getAccountInfo: async () => null }
    }))
    mock.method(SolanaOutpostProgramTool, "derivePda", () => ({ toBase58: () => "config-pda" }))
    await Assert.rejects(DepotPacedEpochsSteps.readSolanaInboundCursor(context()), /the Solana OutpostConfig config-pda does not exist/)
  })

  test("runVerifyIdle reads the observation and both snapshots back", async () => {
    const streams = { outboundEpoch: { [Ethereum]: 4, [Solana]: 2 }, outpostCursor: { [Ethereum]: 5, [Solana]: 3 } },
      outputs = new OutputStore()
        .set(WireEconomicClockTool.observationKey("w"), idleObservation())
        .set(DepotPacedEpochsSteps.streamSnapshotKey("a"), streams)
        .set(DepotPacedEpochsSteps.streamSnapshotKey("b"), streams),
      input = {
        kind: "DepotPacedEpochsSteps.VerifyIdleInput",
        observationName: "w",
        fromSnapshotName: "a",
        toSnapshotName: "b"
      }
    await DepotPacedEpochsSteps.runVerifyIdle(context(outputs), input, signal)
    outputs.set(WireEconomicClockTool.observationKey("w"), idleObservation(consensus(5)))
    await Assert.rejects(DepotPacedEpochsSteps.runVerifyIdle(context(outputs), input, signal), /moved from epoch 4 to 5/)
  })
})

describe("traffic", () => {
  test("a strict majority of the seats reporting, dated by its oldest message, passes", () => {
    const due = dueObservation()
    DepotPacedEpochsSteps.assertBacklogMajority([report("batchop.b"), report("batchop.c")], due, Ethereum)
    // The m-th smallest is the traffic: a third report with a later oldest does not move it.
    DepotPacedEpochsSteps.assertBacklogMajority(
      [report("batchop.b"), report("batchop.c"), report(Member, 4, BaseMs + 110_000)],
      due,
      Ethereum
    )
  })

  test("reports outside the group, of another epoch or chain, or with nothing pending do not count", () => {
    const due = dueObservation()
    ;[
      [report("batchop.b"), report("batchop.x")],
      [report("batchop.b"), report("batchop.c", 3)],
      [report("batchop.b"), report("batchop.c", 4, BaseMs + 100_000, 0)],
      [report("batchop.b"), report("batchop.c", 4, BaseMs + 100_000, 3, Solana)]
    ].forEach(rows =>
      Assert.throws(
        () => DepotPacedEpochsSteps.assertBacklogMajority(rows, due, Ethereum),
        /1 of the 3 seats on duty reported the ETHEREUM backlog in epoch 4, under the 2 a strict majority needs/
      )
    )
  })

  test("traffic dated other than the majority's oldest message fails", () => {
    Assert.throws(
      () =>
        DepotPacedEpochsSteps.assertBacklogMajority(
          [report("batchop.b", 4, BaseMs + 90_000), report("batchop.c", 4, BaseMs + 95_000)],
          dueObservation(),
          Ethereum
        ),
      /the ETHEREUM traffic dates from .*, not the oldest pending message the majority reported/
    )
  })

  test("an advance at or within the slack of due passes; early, late or skipped fails", () => {
    const due = dueObservation(),
      dueAtMs = due.reading.dueAtMs,
      slackMs = DepotPacedEpochsSteps.advanceSlackMs(60)
    DepotPacedEpochsSteps.assertTimelyAdvance(due, consensus(5, { epochStartMs: dueAtMs }), 60, Ethereum)
    DepotPacedEpochsSteps.assertTimelyAdvance(due, consensus(5, { epochStartMs: dueAtMs + slackMs }), 60, Ethereum)
    Assert.throws(
      () => DepotPacedEpochsSteps.assertTimelyAdvance(due, consensus(5, { epochStartMs: dueAtMs - 1 }), 60, Ethereum),
      /opened at .*, before it was due at/
    )
    Assert.throws(
      () => DepotPacedEpochsSteps.assertTimelyAdvance(due, consensus(5, { epochStartMs: dueAtMs + slackMs + 1 }), 60, Ethereum),
      /the ETHEREUM epoch 5 opened at .*, after/
    )
    Assert.throws(
      () => DepotPacedEpochsSteps.assertTimelyAdvance(due, consensus(6, { epochStartMs: dueAtMs }), 60, Ethereum),
      /moved from epoch 4 to 6, not once/
    )
  })

  test("traffic recorded after its due time allows the advance one slack after it was observed", () => {
    const due = dueObservation(BaseMs + 100_000, BaseMs + 140_000),
      openedMs = due.observedAtMs + DepotPacedEpochsSteps.advanceSlackMs(60)
    DepotPacedEpochsSteps.assertTimelyAdvance(due, consensus(5, { epochStartMs: openedMs }), 60, Ethereum)
  })

  test("other chains held at the snapshot pass; one that moved fails", () => {
    const before = { [Ethereum]: 4, [Solana]: 2 }
    DepotPacedEpochsSteps.assertOtherChainsHeld(before, readings(consensus(5), consensus(2)), Ethereum)
    Assert.throws(
      () => DepotPacedEpochsSteps.assertOtherChainsHeld(before, readings(consensus(5), consensus(3)), Ethereum),
      /the SOLANA chain moved from epoch 2 to 3 on ETHEREUM traffic/
    )
  })

  test("the burst in the one epoch after the due one passes; a split burst or a second advance fails", () => {
    const item = (epoch_index, pubkey = "holder") => ({
        pubkey,
        epoch_index,
        kind: "SYNDICATION",
        amount: "10000000",
        remaining: "10000000"
      }),
      due = dueObservation()
    DepotPacedEpochsSteps.assertBurstInOneEpoch([item(5), item(5), item(5), item(5, "other")], "holder", 3, due, consensus(5))
    Assert.throws(
      () => DepotPacedEpochsSteps.assertBurstInOneEpoch([item(5), item(5)], "holder", 3, due, consensus(5)),
      /2 of the 3 syndications landed in depot epoch 5/
    )
    Assert.throws(
      () => DepotPacedEpochsSteps.assertBurstInOneEpoch([item(5), item(5), item(5)], "holder", 3, due, consensus(6)),
      /moved from epoch 4 to 6, not once/
    )
  })

  test("runAwaitChainDue stores the reading, its head and group once the chain has traffic", async () => {
    pollOnce()
    const { reading: due } = dueObservation()
    mock.method(WireEconomicClockTool, "readConsensusReadings", async () => readings(due, consensus(2)))
    mock.method(Steps.contracts.sysio.epoch, "readEpochConfigs", async () => ({
      [Ethereum]: { epoch_duration_sec: 60, traffic_wait_sec: 30 }
    }))
    mock.method(Steps.contracts.sysio.epoch, "activeBatchOperatorGroup", async () => Group)
    const ctx = context(new OutputStore(), { wire: { getInfo: async () => ({ head_block_time: stamp(BaseMs + 5_000) }) } })
    await DepotPacedEpochsSteps.runAwaitChainDue(ctx, { kind: "DepotPacedEpochsSteps.ChainInput", chain: Ethereum }, signal)
    Assert.deepEqual(ctx.outputs.assert(DepotPacedEpochsSteps.dueObservationKey(Ethereum)), {
      reading: due,
      observedAtMs: BaseMs + 5_000,
      group: Group
    })
  })

  test("runAwaitChainDue fails while the chain is idle, and on a due_at off the rule", async () => {
    pollOnce()
    const read = mock.method(WireEconomicClockTool, "readConsensusReadings", async () => readings(consensus(4), consensus(2)))
    mock.method(Steps.contracts.sysio.epoch, "readEpochConfigs", async () => ({
      [Ethereum]: { epoch_duration_sec: 60, traffic_wait_sec: 30 }
    }))
    mock.method(Steps.contracts.sysio.epoch, "activeBatchOperatorGroup", async () => Group)
    const ctx = context(new OutputStore(), { wire: { getInfo: async () => ({ head_block_time: stamp(BaseMs) }) } }),
      input = { kind: "DepotPacedEpochsSteps.ChainInput", chain: Ethereum }
    await Assert.rejects(DepotPacedEpochsSteps.runAwaitChainDue(ctx, input, signal), /Timed out waiting for: the ETHEREUM chain has traffic/)
    read.mock.mockImplementation(async () =>
      readings(consensus(4, { trafficSinceMs: BaseMs, dueAtMs: BaseMs + 60_000 * 3 }), consensus(2))
    )
    await Assert.rejects(DepotPacedEpochsSteps.runAwaitChainDue(ctx, input, signal), /is not due at the later of its start/)
  })

  test("runVerifyBacklogReports checks the qreports rows against the due observation", async () => {
    const outputs = new OutputStore().set(DepotPacedEpochsSteps.dueObservationKey(Ethereum), dueObservation()),
      input = { kind: "DepotPacedEpochsSteps.ChainInput", chain: Ethereum }
    await DepotPacedEpochsSteps.runVerifyBacklogReports(
      context(outputs, { wire: wireOf({ qreports: [report("batchop.b"), report("batchop.c")] }) }),
      input,
      signal
    )
    await Assert.rejects(
      DepotPacedEpochsSteps.runVerifyBacklogReports(context(outputs, { wire: wireOf({ qreports: [report("batchop.b")] }) }), input, signal),
      /1 of the 3 seats on duty reported/
    )
  })

  test("runAwaitDueAdvance checks the advance and the other chain against the snapshot", async () => {
    pollOnce()
    const due = dueObservation(),
      outputs = new OutputStore()
        .set(DepotPacedEpochsSteps.dueObservationKey(Ethereum), due)
        .set(Steps.epochAdvance.epochIndicesKey("before"), { [Ethereum]: 4, [Solana]: 2 }),
      input = { kind: "DepotPacedEpochsSteps.AwaitDueAdvanceInput", chain: Ethereum, beforeSnapshotName: "before" },
      read = mock.method(WireEconomicClockTool, "readConsensusReadings", async () =>
        readings(consensus(5, { epochStartMs: due.reading.dueAtMs + 1_000 }), consensus(2))
      )
    await DepotPacedEpochsSteps.runAwaitDueAdvance(context(outputs), input, signal)
    read.mock.mockImplementation(async () => readings(consensus(4), consensus(2)))
    await Assert.rejects(DepotPacedEpochsSteps.runAwaitDueAdvance(context(outputs), input, signal), /advances past epoch 4/)
    read.mock.mockImplementation(async () =>
      readings(consensus(5, { epochStartMs: due.reading.dueAtMs + 1_000 }), consensus(3))
    )
    await Assert.rejects(DepotPacedEpochsSteps.runAwaitDueAdvance(context(outputs), input, signal), /SOLANA chain moved from epoch 2 to 3/)
  })

  test("runVerifyBurstInOneEpoch reads the pair's items of the epoch after the due one", async () => {
    mock.method(EthereumFundingTool, "compressedPubkey", () => "0xholder")
    const items = mock.method(WireSyndicationTool, "readItems", async () =>
      [5, 5, 5].map(epoch_index => ({ pubkey: "holder", epoch_index, kind: SysioSyndItemKind.SYNDICATION }))
    )
    mock.method(WireEconomicClockTool, "readConsensusReadings", async () => readings(consensus(5), consensus(2)))
    const outputs = new OutputStore().set(DepotPacedEpochsSteps.dueObservationKey(Ethereum), dueObservation())
    await DepotPacedEpochsSteps.runVerifyBurstInOneEpoch(
      context(outputs),
      { kind: "DepotPacedEpochsSteps.VerifyBurstInOneEpochInput", walletName: "w", count: 3 },
      signal
    )
    Assert.deepEqual(items.mock.calls[0].arguments.slice(1), [Ethereum, "LIQETH", 5])
  })
})

describe("majority and a late delivery", () => {
  const duty = { epochIndex: 5, group: Group },
    secondMs = BaseMs + 8_000

  test("two of three seats, the winner's bytes, accepted with the second delivery, passes", () => {
    DepotPacedEpochsSteps.assertMajorityDecision(
      [envelope("batchop.b", 5, BaseMs + 5_000), envelope("batchop.c", 5, secondMs)],
      [envelopeLog(5, BaseMs + 1_000, false), envelopeLog(5, secondMs), envelopeLog(4, BaseMs - 60_000)],
      duty,
      Member,
      Winner,
      Ethereum
    )
  })

  test("a bucket that is not the majority, holds the stopped member or another envelope, fails", () => {
    const log = [envelopeLog(5, secondMs)]
    Assert.throws(
      () =>
        DepotPacedEpochsSteps.assertMajorityDecision(
          [envelope("batchop.b", 5, BaseMs), envelope("batchop.c", 5, BaseMs), envelope(Member, 5, secondMs)],
          log,
          duty,
          Member,
          Winner,
          Ethereum
        ),
      /holds 3 deliveries, not the 2 of 3 seats a strict majority needs/
    )
    Assert.throws(
      () =>
        DepotPacedEpochsSteps.assertMajorityDecision(
          [envelope("batchop.b", 5, BaseMs), envelope(Member, 5, secondMs)],
          log,
          duty,
          Member,
          Winner,
          Ethereum
        ),
      /the stopped batchop.a delivered the ETHEREUM epoch 5/
    )
    Assert.throws(
      () =>
        DepotPacedEpochsSteps.assertMajorityDecision(
          [envelope("batchop.b", 5, BaseMs), envelope("batchop.c", 5, secondMs, Other)],
          log,
          duty,
          Member,
          Winner,
          Ethereum
        ),
      /differs from its accepted envelope/
    )
  })

  test("an acceptance missing or not with the last delivery fails", () => {
    const bucket = [envelope("batchop.b", 5, BaseMs + 5_000), envelope("batchop.c", 5, secondMs)]
    Assert.throws(
      () => DepotPacedEpochsSteps.assertMajorityDecision(bucket, [envelopeLog(5, secondMs, false)], duty, Member, Winner, Ethereum),
      /has 0 inbound envlog rows/
    )
    Assert.throws(
      () => DepotPacedEpochsSteps.assertMajorityDecision(bucket, [envelopeLog(5, secondMs + 500)], duty, Member, Winner, Ethereum),
      /was accepted at .*, not with its last delivery/
    )
  })

  test("a late delivery of the winner's bytes inside the window passes; outside it or different fails", () => {
    const windowStartMs = BaseMs + 60_000
    DepotPacedEpochsSteps.assertLateDelivery(envelope(Member, 5, windowStartMs), Winner, windowStartMs, 30, Ethereum)
    DepotPacedEpochsSteps.assertLateDelivery(envelope(Member, 5, windowStartMs + 29_500), Winner, windowStartMs, 30, Ethereum)
    Assert.throws(
      () => DepotPacedEpochsSteps.assertLateDelivery(envelope(Member, 5, windowStartMs - 500), Winner, windowStartMs, 30, Ethereum),
      /before the next epoch opened: it was not late/
    )
    Assert.throws(
      () => DepotPacedEpochsSteps.assertLateDelivery(envelope(Member, 5, windowStartMs + 30_000), Winner, windowStartMs, 30, Ethereum),
      /after the late window closed/
    )
    Assert.throws(
      () => DepotPacedEpochsSteps.assertLateDelivery(envelope(Member, 5, windowStartMs, Other), Winner, windowStartMs, 30, Ethereum),
      /late ETHEREUM delivery differs from the accepted envelope/
    )
  })

  test("the books credit one delivered row of the member's epoch; a miss, none or several fail", () => {
    const rows = [delivery(Member, 5), delivery(Member, 4, false), delivery("batchop.b", 5), delivery(Member, 5, true, Solana)],
      own = DepotPacedEpochsSteps.memberDeliveryRows(rows, Member, Ethereum, 5)
    Assert.deepEqual(own, [delivery(Member, 5)])
    DepotPacedEpochsSteps.assertDeliveryCredited(own, Member, 5)
    Assert.throws(() => DepotPacedEpochsSteps.assertDeliveryCredited([delivery(Member, 5, false)], Member, 5), /record batchop.a's delivery as a miss/)
    Assert.throws(() => DepotPacedEpochsSteps.assertDeliveryCredited([], Member, 5), /batchop.a has 0 dellog rows of epoch 5/)
    Assert.throws(
      () => DepotPacedEpochsSteps.assertDeliveryCredited([delivery(Member, 5), delivery(Member, 5)], Member, 5),
      /batchop.a has 2 dellog rows of epoch 5/
    )
  })

  test("the member is next on duty on a decided epoch whose advance is idle or a graceful stop away", () => {
    const headMs = BaseMs + 10_000,
      dueIn = ms => ({ ...epochState(4), traffic_since: stamp(BaseMs), due_at: stamp(headMs + ms) })
    Assert.deepEqual(DepotPacedEpochsSteps.nextDutyEpochOf(epochState(4), outpostConsensus(4), Member, headMs), duty)
    Assert.deepEqual(
      DepotPacedEpochsSteps.nextDutyEpochOf(dueIn(ManagedProcess.GracefulKillMs), outpostConsensus(4), Member, headMs),
      duty
    )
    // The advance is closer than a graceful stop, the epoch is undecided, or another group is next.
    Assert.equal(
      DepotPacedEpochsSteps.nextDutyEpochOf(dueIn(ManagedProcess.GracefulKillMs - 1), outpostConsensus(4), Member, headMs),
      undefined
    )
    Assert.equal(DepotPacedEpochsSteps.nextDutyEpochOf(epochState(4), outpostConsensus(3), Member, headMs), undefined)
    Assert.equal(
      DepotPacedEpochsSteps.nextDutyEpochOf(epochState(4, [Group, ["x"], ["y"]]), outpostConsensus(4), Member, headMs),
      undefined
    )
    Assert.equal(DepotPacedEpochsSteps.nextDutyEpochOf(undefined, outpostConsensus(4), Member, headMs), undefined)
  })

  test("runAwaitMemberNextOnDuty records the next epoch and its group once the member is next", async () => {
    pollOnce()
    const pushed = recordPump({ [Ethereum]: epochState(4), [Solana]: epochState(2, undefined, 0, Solana) })
    mock.method(Steps.contracts.sysio.msgch, "readOutpostConsensus", async () => ({ [Ethereum]: outpostConsensus(4) }))
    const ctx = context(new OutputStore(), { wire: { getInfo: async () => ({ head_block_time: stamp(BaseMs) }) } }),
      input = { kind: "DepotPacedEpochsSteps.MemberInput", chain: Ethereum, label: Member }
    await DepotPacedEpochsSteps.runAwaitMemberNextOnDuty(ctx, input, signal)
    Assert.deepEqual(ctx.outputs.assert(DepotPacedEpochsSteps.DutyEpochKey), duty)
    Assert.deepEqual(pushed(), [])
  })

  test("runAwaitMemberNextOnDuty pumps an idle chain whose next group leaves the member out", async () => {
    pollOnce()
    const pushed = recordPump({
      [Ethereum]: epochState(4, [Group, ["batchop.d"], ["batchop.g"]]),
      [Solana]: epochState(2, undefined, 0, Solana)
    })
    mock.method(Steps.contracts.sysio.msgch, "readOutpostConsensus", async () => ({ [Ethereum]: outpostConsensus(4) }))
    const ctx = context(new OutputStore(), { wire: { getInfo: async () => ({ head_block_time: stamp(BaseMs) }) } })
    await Assert.rejects(
      DepotPacedEpochsSteps.runAwaitMemberNextOnDuty(
        ctx,
        { kind: "DepotPacedEpochsSteps.MemberInput", chain: Ethereum, label: Member },
        signal
      ),
      /batchop.a sits in the ETHEREUM group on duty next/
    )
    Assert.deepEqual(pushed(), [Ethereum])
  })

  test("runAwaitMajorityDecision checks the decided epoch's bucket and records its winner", async () => {
    pollOnce()
    recordPump({ [Ethereum]: epochState(5), [Solana]: epochState(2, undefined, 0, Solana) })
    mock.method(Steps.contracts.sysio.msgch, "readOutpostConsensus", async () => ({ [Ethereum]: outpostConsensus(5) }))
    mock.method(Steps.contracts.sysio.msgch, "readEnvelopes", async () => [
      envelope("batchop.b", 5, BaseMs + 5_000),
      envelope("batchop.c", 5, secondMs),
      envelope("batchop.d", 4, BaseMs)
    ])
    const outputs = new OutputStore().set(DepotPacedEpochsSteps.DutyEpochKey, duty),
      ctx = context(outputs, { wire: wireOf({ envlog: [envelopeLog(5, secondMs)] }) })
    await DepotPacedEpochsSteps.runAwaitMajorityDecision(ctx, { kind: "DepotPacedEpochsSteps.MemberInput", chain: Ethereum, label: Member }, signal)
    Assert.equal(outputs.assert(DepotPacedEpochsSteps.WinningChecksumKey), Winner)
  })

  test("runAwaitMajorityDecision fails on a decision past the duty epoch", async () => {
    pollOnce()
    recordPump({ [Ethereum]: epochState(6), [Solana]: epochState(2, undefined, 0, Solana) })
    mock.method(Steps.contracts.sysio.msgch, "readOutpostConsensus", async () => ({ [Ethereum]: outpostConsensus(6) }))
    const ctx = context(new OutputStore().set(DepotPacedEpochsSteps.DutyEpochKey, duty))
    await Assert.rejects(
      DepotPacedEpochsSteps.runAwaitMajorityDecision(ctx, { kind: "DepotPacedEpochsSteps.MemberInput", chain: Ethereum, label: Member }, signal),
      /the ETHEREUM chain decided epoch 6 past epoch 5/
    )
  })

  test("runAwaitNextEpochOpened records the next epoch's start; a skipped epoch fails", async () => {
    pollOnce()
    recordPump({ [Ethereum]: epochState(6), [Solana]: epochState(2, undefined, 0, Solana) })
    const outputs = new OutputStore().set(DepotPacedEpochsSteps.DutyEpochKey, duty),
      input = { kind: "DepotPacedEpochsSteps.ChainInput", chain: Ethereum },
      read = mock.method(WireEconomicClockTool, "readConsensusReadings", async () =>
        readings(consensus(6, { epochStartMs: BaseMs + 60_000 }), consensus(2))
      )
    await DepotPacedEpochsSteps.runAwaitNextEpochOpened(context(outputs), input, signal)
    Assert.equal(outputs.assert(DepotPacedEpochsSteps.LateWindowStartKey), BaseMs + 60_000)
    read.mock.mockImplementation(async () => readings(consensus(7), consensus(2)))
    await Assert.rejects(DepotPacedEpochsSteps.runAwaitNextEpochOpened(context(outputs), input, signal), /moved from epoch 5 to 7/)
  })

  test("runAwaitLateDelivery finds the member's row and checks it against the chain's late window", async () => {
    pollOnce()
    const windowStartMs = BaseMs + 60_000,
      outputs = new OutputStore()
        .set(DepotPacedEpochsSteps.DutyEpochKey, duty)
        .set(DepotPacedEpochsSteps.WinningChecksumKey, Winner)
        .set(DepotPacedEpochsSteps.LateWindowStartKey, windowStartMs),
      input = { kind: "DepotPacedEpochsSteps.MemberInput", chain: Ethereum, label: Member },
      rows = mock.method(Steps.contracts.sysio.msgch, "readEnvelopes", async () => [
        envelope("batchop.b", 5, BaseMs),
        envelope(Member, 5, windowStartMs + 10_000)
      ])
    mock.method(Steps.contracts.sysio.epoch, "readEpochConfig", async () => ({ late_window_sec: 30 }))
    await DepotPacedEpochsSteps.runAwaitLateDelivery(context(outputs), input, signal)
    rows.mock.mockImplementation(async () => [envelope("batchop.b", 5, BaseMs)])
    await Assert.rejects(DepotPacedEpochsSteps.runAwaitLateDelivery(context(outputs), input, signal), /batchop.a delivers the ETHEREUM epoch 5 late/)
  })

  test("runAwaitDeliveryCredited waits for the member's dellog row of the duty epoch and checks it", async () => {
    pollOnce()
    recordPump({ [Ethereum]: epochState(7), [Solana]: epochState(2, undefined, 0, Solana) })
    const outputs = new OutputStore().set(DepotPacedEpochsSteps.DutyEpochKey, duty),
      input = { kind: "DepotPacedEpochsSteps.MemberInput", chain: Ethereum, label: Member }
    await DepotPacedEpochsSteps.runAwaitDeliveryCredited(context(outputs, { wire: wireOf({ dellog: [delivery(Member, 5)] }) }), input, signal)
    await Assert.rejects(
      DepotPacedEpochsSteps.runAwaitDeliveryCredited(context(outputs, { wire: wireOf({ dellog: [delivery(Member, 5, false)] }) }), input, signal),
      /as a miss/
    )
    await Assert.rejects(
      DepotPacedEpochsSteps.runAwaitDeliveryCredited(context(outputs, { wire: wireOf({ dellog: [] }) }), input, signal),
      /the books of the ETHEREUM epoch 5 close/
    )
  })

  test("runAwaitDecidedAndIdle waits on the chain at the flow's poll interval", async () => {
    const wait = mock.method(Steps.epochAdvance, "awaitDecidedAndIdle", async () => undefined),
      ctx = context()
    await DepotPacedEpochsSteps.runAwaitDecidedAndIdle(ctx, { kind: "DepotPacedEpochsSteps.ChainInput", chain: Solana }, signal)
    Assert.deepEqual(wait.mock.calls[0].arguments, [ctx, Solana, Constants.PollIntervalMs])
  })
})

describe("reads", () => {
  test("the outbound envelope read refuses a truncated table", async () => {
    const ctx = context(new OutputStore(), {
      wire: { getSysioContract: () => ({ tables: { outenvelopes: { query: async () => ({ rows: [], more: true }) } } }) }
    })
    await Assert.rejects(DepotPacedEpochsSteps.readOutboundEnvelopes(ctx), /outenvelopes has more than 100 rows; the read is truncated/)
  })

  test("the log reads ask sysio.msgch and sysio.opreg for every row", async () => {
    const asked = [],
      ctx = context(new OutputStore(), {
        wire: {
          getSysioContract: name => {
            asked.push(name)
            return { tables: { qreports: { queryAll: async () => [] }, envlog: { queryAll: async () => [] }, dellog: { queryAll: async () => [] } } }
          }
        }
      })
    await DepotPacedEpochsSteps.readQueueReports(ctx)
    await DepotPacedEpochsSteps.readEnvelopeLog(ctx)
    await DepotPacedEpochsSteps.readDeliveryLog(ctx)
    Assert.deepEqual(asked, [SysioContractName.msgch, SysioContractName.msgch, SysioContractName.opreg])
  })
})
