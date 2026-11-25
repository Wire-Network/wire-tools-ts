import { SlugName, SysioContracts } from "@wireio/sdk-core"

import {
  OutpostChainCodename,
  OutpostChainCodenames,
  mapOutpostChains,
  type PerOutpostChain
} from "@wireio/cluster-tool-shared"
import { ProtocolTiming } from "@wireio/cluster-tool/Constants"
import {
  Steps,
  type ClusterBuildContext
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

const { ETHEREUM, SOLANA } = OutpostChainCodename,
  EthereumDurationSec = 60,
  SolanaDurationSec = 150,
  /** The Solana default's duration: three effective epochs fall under the restart floor. */
  ShortSolanaDurationSec = 15,
  signal = new AbortController().signal

/** Every chain's index: Ethereum at `ethereum`, Solana at `solana`. */
function indices(ethereum: number, solana: number): PerOutpostChain<number> {
  return { [ETHEREUM]: ethereum, [SOLANA]: solana }
}

/** A real context whose chains run 60 s (Ethereum) and 150 s (Solana) epochs. */
function context(): ClusterBuildContext {
  return fixtureContext({
    outpostEpochDurationSec: indices(EthereumDurationSec, SolanaDurationSec)
  })
}

/** Serve one `readCurrentEpochIndices` result per read, in order; the last repeats. */
function serveIndices(
  ...reads: ReadonlyArray<PerOutpostChain<number> | Error>
): jest.SpyInstance {
  const spy = jest.spyOn(Steps.contracts.sysio.epoch, "readCurrentEpochIndices")
  reads.forEach((read, index) => {
    const isLast = index === reads.length - 1
    if (read instanceof Error) {
      spy.mockRejectedValueOnce(read)
    } else if (isLast) {
      spy.mockResolvedValue(read)
    } else {
      spy.mockResolvedValueOnce(read)
    }
  })
  return spy
}

/** A zero `time_point` as the chain renders it: no traffic. */
const NoTraffic = "1970-01-01T00:00:00.000",
  /** A `due_at` of a chain with traffic. */
  Due = "2026-11-25T00:01:10.000"

/** One chain's `epochstate` row at `index`, due at `dueAt` (zero: idle), paused or not. */
function epochState(
  chain: OutpostChainCodename,
  index: number,
  dueAt = NoTraffic,
  isPaused = false
): SysioContracts.SysioEpochEpochStateType {
  return {
    chain_code: SlugName.from(chain),
    current_epoch_index: index,
    current_epoch_start: "2026-11-25T00:00:00.000",
    traffic_since: dueAt === NoTraffic ? NoTraffic : "2026-11-25T00:00:10.000",
    due_at: dueAt,
    current_batch_op_group: 0,
    batch_op_groups: [],
    is_paused: isPaused,
    previous_group: []
  }
}

/** Every chain's `epochstate` row: both idle at `index` unless overridden. */
function states(
  overrides: Partial<PerOutpostChain<SysioContracts.SysioEpochEpochStateType>> = {},
  index = 3
): PerOutpostChain<SysioContracts.SysioEpochEpochStateType> {
  return {
    [ETHEREUM]: epochState(ETHEREUM, index),
    [SOLANA]: epochState(SOLANA, index),
    ...overrides
  }
}

/** Serve `readEpochStates` (the pump's read) with `read` on every call. */
function serveStates(
  read: PerOutpostChain<SysioContracts.SysioEpochEpochStateType> | Error
): jest.SpyInstance {
  const spy = jest.spyOn(Steps.contracts.sysio.epoch, "readEpochStates")
  if (read instanceof Error) spy.mockRejectedValue(read)
  else spy.mockResolvedValue(read)
  return spy
}

/** Stub the pump's write: every `runNotetraffic` resolves, or rejects with `error`. */
function stubNotetraffic(error: Error = null): jest.SpyInstance {
  const spy = jest.spyOn(Steps.contracts.sysio.epoch, "runNotetraffic")
  if (error != null) spy.mockRejectedValue(error)
  else spy.mockResolvedValue(undefined)
  return spy
}

/** The chains the pump gave traffic, in push order. */
function pumpedChains(notetraffic: jest.SpyInstance): string[] {
  return notetraffic.mock.calls.map(([, input]) => input.data.chain_code)
}

/** One `outpcons` row per chain given, recording a winner for its epoch. */
function consensusRows(
  epochs: Partial<PerOutpostChain<number>>
): PerOutpostChain<SysioContracts.SysioMsgchOutpostConsensusEntryType> {
  return mapOutpostChains(chain =>
    epochs[chain] == null
      ? undefined
      : ({
          chain_code: SlugName.from(chain),
          epoch_index: epochs[chain]
        } as SysioContracts.SysioMsgchOutpostConsensusEntryType)
  )
}

/** Serve one `readOutpostConsensus` result per read, in order; the last repeats. */
function serveConsensus(
  ...reads: ReadonlyArray<Partial<PerOutpostChain<number>> | Error>
): jest.SpyInstance {
  const spy = jest.spyOn(Steps.contracts.sysio.msgch, "readOutpostConsensus")
  reads.forEach((read, index) => {
    if (read instanceof Error) spy.mockRejectedValueOnce(read)
    else if (index === reads.length - 1) spy.mockResolvedValue(consensusRows(read))
    else spy.mockResolvedValueOnce(consensusRows(read))
  })
  return spy
}

/**
 * Settle an assertion over a poll under fake timers: every poll interval elapses at once, so a
 * poll's deadline passes without waiting it out.
 */
async function underFakeTimers(assertion: Promise<void>): Promise<void> {
  await jest.runAllTimersAsync()
  await assertion
}

describe("EpochAdvanceSteps", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  describe("budgets", () => {
    it("sizes one chain's gate by its own duration", () => {
      const ctx = context()
      expect(
        Steps.epochAdvance.epochAdvanceBudgetMs(ctx.config, ETHEREUM)
      ).toBe(
        ProtocolTiming.effectiveEpochsMs(
          EthereumDurationSec,
          ProtocolTiming.EpochVerifyEpochCount
        )
      )
      expect(Steps.epochAdvance.epochAdvanceBudgetMs(ctx.config, SOLANA)).toBe(
        ProtocolTiming.effectiveEpochsMs(
          SolanaDurationSec,
          ProtocolTiming.EpochVerifyEpochCount
        )
      )
    })

    it("holds a short-epoch chain's gate to the OPP circulation restart, not its epochs", () => {
      const ctx = fixtureContext({
        outpostEpochDurationSec: indices(EthereumDurationSec, ShortSolanaDurationSec)
      })
      expect(Steps.epochAdvance.epochAdvanceBudgetMs(ctx.config, SOLANA)).toBe(
        ProtocolTiming.OppCirculationRestartMs
      )
      expect(Steps.epochAdvance.epochAdvanceBudgetMs(ctx.config, ETHEREUM)).toBe(
        ProtocolTiming.effectiveEpochsMs(
          EthereumDurationSec,
          ProtocolTiming.EpochVerifyEpochCount
        )
      )
    })

    it("sizes an every-chain wait by the slowest chain", () => {
      expect(
        Steps.epochAdvance.everyChainAdvanceBudgetMs(context().config)
      ).toBe(
        ProtocolTiming.effectiveEpochsMs(
          SolanaDurationSec,
          ProtocolTiming.EpochVerifyEpochCount
        )
      )
    })

    it("floors an every-chain wait at the OPP circulation restart when every chain is short", () => {
      const ctx = fixtureContext({
        outpostEpochDurationSec: indices(ShortSolanaDurationSec, ShortSolanaDurationSec)
      })
      expect(Steps.epochAdvance.everyChainAdvanceBudgetMs(ctx.config)).toBe(
        ProtocolTiming.OppCirculationRestartMs
      )
    })
  })

  describe("hasDecidedEpoch", () => {
    it("holds once outpcons records a winner for the epoch or a later one", () => {
      const row = (epochIndex: number) =>
        ({ epoch_index: epochIndex }) as SysioContracts.SysioMsgchOutpostConsensusEntryType
      expect(Steps.epochAdvance.hasDecidedEpoch(row(1), 1)).toBe(true)
      expect(Steps.epochAdvance.hasDecidedEpoch(row(4), 1)).toBe(true)
      expect(Steps.epochAdvance.hasDecidedEpoch(row(1), 2)).toBe(false)
    })

    it("is false before the chain's first accepted winner", () => {
      expect(Steps.epochAdvance.hasDecidedEpoch(undefined, 1)).toBe(false)
    })
  })

  describe("planAwaitEpochDecided", () => {
    it("carries its chain to the named runner", () => {
      const step = Steps.epochAdvance.planAwaitEpochDecided(
        Report.Actor.Sysio,
        "gate",
        "gate",
        {},
        SOLANA
      )
      expect(step.input).toEqual({
        kind: "EpochAdvanceSteps.AwaitEpochDecidedInput",
        chain: SOLANA
      })
      expect(step.runner).toBe(Steps.epochAdvance.runAwaitEpochDecided)
      expect(Steps.epochAdvance.BootstrapDecidedEpochIndex).toBe(1)
    })

    it("resolves once ITS chain's genesis epoch is decided, whatever the other chain reads, and adds no traffic", async () => {
      const notetraffic = stubNotetraffic(),
        reads = serveConsensus({ [ETHEREUM]: 1 }, { [ETHEREUM]: 1, [SOLANA]: 1 })
      await underFakeTimers(
        expect(
          Steps.epochAdvance.runAwaitEpochDecided(
            context(),
            { kind: "EpochAdvanceSteps.AwaitEpochDecidedInput", chain: SOLANA },
            signal
          )
        ).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(2)
      expect(notetraffic).not.toHaveBeenCalled()
    })

    it("resolves on the first read when a later epoch is already decided", async () => {
      const reads = serveConsensus({ [ETHEREUM]: 5 })
      await underFakeTimers(
        expect(
          Steps.epochAdvance.runAwaitEpochDecided(
            context(),
            { kind: "EpochAdvanceSteps.AwaitEpochDecidedInput", chain: ETHEREUM },
            signal
          )
        ).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(1)
    })

    it("keeps polling through a transient read error", async () => {
      const reads = serveConsensus(new Error("rpc reset"), { [ETHEREUM]: 1 })
      await underFakeTimers(
        expect(
          Steps.epochAdvance.runAwaitEpochDecided(
            context(),
            { kind: "EpochAdvanceSteps.AwaitEpochDecidedInput", chain: ETHEREUM },
            signal
          )
        ).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(2)
    })

    it("times out with the chain named when its genesis epoch is never decided", async () => {
      serveConsensus({ [ETHEREUM]: 1 })
      await underFakeTimers(
        expect(
          Steps.epochAdvance.runAwaitEpochDecided(
            context(),
            { kind: "EpochAdvanceSteps.AwaitEpochDecidedInput", chain: SOLANA },
            signal
          )
        ).rejects.toThrow(
          `Timed out waiting for: the ${SOLANA} epoch ${Steps.epochAdvance.BootstrapDecidedEpochIndex} is decided`
        )
      )
    })

    it("refuses to run once aborted", async () => {
      await expect(
        Steps.epochAdvance.runAwaitEpochDecided(
          context(),
          { kind: "EpochAdvanceSteps.AwaitEpochDecidedInput", chain: ETHEREUM },
          AbortSignal.abort()
        )
      ).rejects.toThrow()
    })
  })

  describe("chainsToKeepDue", () => {
    it("picks every started, idle, unpaused chain in the requested order", () => {
      expect(Steps.epochAdvance.chainsToKeepDue(states(), [SOLANA, ETHEREUM])).toEqual([
        SOLANA,
        ETHEREUM
      ])
    })

    it("leaves out a chain that has traffic, is paused, has not started, or was not requested", () => {
      const read = states({
        [ETHEREUM]: epochState(ETHEREUM, 3, Due),
        [SOLANA]: epochState(SOLANA, 3, NoTraffic, true)
      })
      expect(Steps.epochAdvance.chainsToKeepDue(read, OutpostChainCodenames)).toEqual([])
      expect(Steps.epochAdvance.chainsToKeepDue(states({}, 0), OutpostChainCodenames)).toEqual([])
      expect(Steps.epochAdvance.chainsToKeepDue(states(), [ETHEREUM])).toEqual([ETHEREUM])
    })

    it("leaves out a chain with no epochstate row", () => {
      expect(
        Steps.epochAdvance.chainsToKeepDue(states({ [SOLANA]: undefined }), [SOLANA])
      ).toEqual([])
    })
  })

  describe("keepDueTrafficInput", () => {
    it("gives the chain traffic since now, which the contract reads off a zero time_point", () => {
      expect(Steps.epochAdvance.keepDueTrafficInput(SOLANA)).toEqual({
        kind: "EpochContractSteps.NotetrafficInput",
        data: { chain_code: SOLANA, since: NoTraffic }
      })
      expect(Steps.contracts.sysio.epoch.TrafficSinceNow).toBe(NoTraffic)
    })
  })

  describe("readKeepDueSnapshot", () => {
    it("reads every chain's epochstate once", async () => {
      const read = serveStates(states())
      await expect(Steps.epochAdvance.readKeepDueSnapshot(context(), [ETHEREUM])).resolves.toEqual(states())
      expect(read).toHaveBeenCalledTimes(1)
    })

    it("reads nothing for no chains", async () => {
      const read = serveStates(states())
      await expect(Steps.epochAdvance.readKeepDueSnapshot(context(), [])).resolves.toBeNull()
      expect(read).not.toHaveBeenCalled()
    })

    it("yields no snapshot when the read fails", async () => {
      serveStates(new Error("rpc reset"))
      await expect(Steps.epochAdvance.readKeepDueSnapshot(context(), [ETHEREUM])).resolves.toBeNull()
    })
  })

  describe("keepChainsDue", () => {
    it("pushes notetraffic since now, through sysio.epoch's named runner, to each idle requested chain only", async () => {
      const notetraffic = stubNotetraffic()
      await expect(
        Steps.epochAdvance.keepChainsDue(
          context(),
          OutpostChainCodenames,
          states({ [SOLANA]: epochState(SOLANA, 3, Due) }),
          signal
        )
      ).resolves.toEqual([ETHEREUM])
      expect(pumpedChains(notetraffic)).toEqual([ETHEREUM])
      expect(notetraffic.mock.calls[0][1]).toEqual({
        kind: "EpochContractSteps.NotetrafficInput",
        data: { chain_code: ETHEREUM, since: Steps.contracts.sysio.epoch.TrafficSinceNow }
      })
    })

    it("never resends the roster: the pump's only write is notetraffic", async () => {
      const resendroster = jest.spyOn(Steps.contracts.sysio.epoch, "runResendroster"),
        notetraffic = stubNotetraffic()
      await Steps.epochAdvance.keepChainsDue(context(), OutpostChainCodenames, states(), signal)
      expect(pumpedChains(notetraffic)).toEqual([ETHEREUM, SOLANA])
      expect(resendroster).not.toHaveBeenCalled()
    })

    it("pushes nothing when every requested chain has traffic in the snapshot", async () => {
      const notetraffic = stubNotetraffic()
      await expect(
        Steps.epochAdvance.keepChainsDue(
          context(),
          OutpostChainCodenames,
          states({ [ETHEREUM]: epochState(ETHEREUM, 3, Due), [SOLANA]: epochState(SOLANA, 3, Due) }),
          signal
        )
      ).resolves.toEqual([])
      expect(notetraffic).not.toHaveBeenCalled()
    })

    it("decides on the snapshot it is given, never on a fresh read", async () => {
      const read = serveStates(states()),
        notetraffic = stubNotetraffic()
      await Steps.epochAdvance.keepChainsDue(
        context(),
        OutpostChainCodenames,
        states({ [ETHEREUM]: epochState(ETHEREUM, 3, Due) }),
        signal
      )
      expect(read).not.toHaveBeenCalled()
      expect(pumpedChains(notetraffic)).toEqual([SOLANA])
    })

    it("logs a refused push and leaves the chain to the next pass", async () => {
      const notetraffic = stubNotetraffic(new Error("missing authority of sysio.msgch"))
      await expect(
        Steps.epochAdvance.keepChainsDue(context(), OutpostChainCodenames, states(), signal)
      ).resolves.toEqual([])
      expect(pumpedChains(notetraffic)).toEqual([ETHEREUM, SOLANA])
    })

    it("pushes nothing without a snapshot (its read failed)", async () => {
      const notetraffic = stubNotetraffic()
      await expect(
        Steps.epochAdvance.keepChainsDue(context(), OutpostChainCodenames, null, signal)
      ).resolves.toEqual([])
      expect(notetraffic).not.toHaveBeenCalled()
    })

    it("refuses to run once aborted", async () => {
      const notetraffic = stubNotetraffic()
      await expect(
        Steps.epochAdvance.keepChainsDue(context(), OutpostChainCodenames, states(), AbortSignal.abort())
      ).rejects.toThrow()
      expect(notetraffic).not.toHaveBeenCalled()
    })
  })

  describe("pollUntilKeepingDue / pollForKeepingDue", () => {
    it("never pumps a wait that already holds, though it reads the snapshot first", async () => {
      const read = serveStates(states()),
        notetraffic = stubNotetraffic(),
        predicate = jest.fn<Promise<boolean>, []>().mockResolvedValue(true)
      await underFakeTimers(
        expect(
          Steps.epochAdvance.pollUntilKeepingDue(
            context(),
            [ETHEREUM],
            "already there",
            predicate,
            1_000,
            100,
            signal
          )
        ).resolves.toBeUndefined()
      )
      expect(read).toHaveBeenCalledTimes(1)
      expect(read.mock.invocationCallOrder[0]).toBeLessThan(predicate.mock.invocationCallOrder[0])
      expect(notetraffic).not.toHaveBeenCalled()
    })

    it("does not pump a chain that advanced between the snapshot and the predicate", async () => {
      // The snapshot still shows the chain's traffic; by the time the predicate runs it has advanced
      // and gone idle, and only the next check sees the wait satisfied.
      jest
        .spyOn(Steps.contracts.sysio.epoch, "readEpochStates")
        .mockResolvedValueOnce(states({ [ETHEREUM]: epochState(ETHEREUM, 3, Due) }))
        .mockResolvedValue(states({}, 4))
      const notetraffic = stubNotetraffic(),
        predicate = jest.fn<Promise<boolean>, []>().mockResolvedValueOnce(false).mockResolvedValue(true)
      await underFakeTimers(
        expect(
          Steps.epochAdvance.pollUntilKeepingDue(
            context(),
            [ETHEREUM],
            "advance",
            predicate,
            10_000,
            100,
            signal
          )
        ).resolves.toBeUndefined()
      )
      expect(notetraffic).not.toHaveBeenCalled()
    })

    it("keeps the awaited chain due on each failed check until the predicate holds", async () => {
      serveStates(states())
      const notetraffic = stubNotetraffic(),
        predicate = jest
          .fn<Promise<boolean>, []>()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(false)
          .mockResolvedValue(true)
      await underFakeTimers(
        expect(
          Steps.epochAdvance.pollUntilKeepingDue(
            context(),
            [SOLANA],
            "intake",
            predicate,
            10_000,
            100,
            signal
          )
        ).resolves.toBeUndefined()
      )
      expect(pumpedChains(notetraffic)).toEqual([SOLANA, SOLANA])
    })

    it("times out with the wait's label when the predicate never holds", async () => {
      serveStates(states())
      stubNotetraffic()
      await underFakeTimers(
        expect(
          Steps.epochAdvance.pollUntilKeepingDue(
            context(),
            [ETHEREUM],
            "the never-arriving intake",
            async () => false,
            1_000,
            100,
            signal
          )
        ).rejects.toThrow("Timed out waiting for: the never-arriving intake")
      )
    })

    it("pollForKeepingDue returns the first value and pumps only while there is none", async () => {
      serveStates(states())
      const notetraffic = stubNotetraffic(),
        read = jest.fn<Promise<string>, []>().mockResolvedValueOnce(null).mockResolvedValue("row")
      await underFakeTimers(
        expect(
          Steps.epochAdvance.pollForKeepingDue(
            context(),
            [ETHEREUM],
            "row",
            read,
            10_000,
            100,
            signal
          )
        ).resolves.toBe("row")
      )
      expect(pumpedChains(notetraffic)).toEqual([ETHEREUM])
    })

    it("pollForKeepingDue reads the snapshot before the value and pumps only on that snapshot", async () => {
      const stateRead = jest
          .spyOn(Steps.contracts.sysio.epoch, "readEpochStates")
          .mockResolvedValueOnce(states({ [ETHEREUM]: epochState(ETHEREUM, 3, Due) }))
          .mockResolvedValue(states()),
        notetraffic = stubNotetraffic(),
        read = jest.fn<Promise<string>, []>().mockResolvedValueOnce(null).mockResolvedValue("row")
      await underFakeTimers(
        expect(
          Steps.epochAdvance.pollForKeepingDue(context(), [ETHEREUM], "row", read, 10_000, 100, signal)
        ).resolves.toBe("row")
      )
      expect(stateRead.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0])
      expect(notetraffic).not.toHaveBeenCalled()
    })
  })

  describe("isDecidedAndIdle", () => {
    const decided = (epochIndex: number) =>
      ({ epoch_index: epochIndex }) as SysioContracts.SysioMsgchOutpostConsensusEntryType

    it("holds once the current epoch is decided and the chain has no traffic", () => {
      expect(Steps.epochAdvance.isDecidedAndIdle(epochState(ETHEREUM, 4), decided(4))).toBe(true)
    })

    it("is false right after an advance, with traffic pending, or without rows", () => {
      expect(Steps.epochAdvance.isDecidedAndIdle(epochState(ETHEREUM, 4), decided(3))).toBe(false)
      expect(Steps.epochAdvance.isDecidedAndIdle(epochState(ETHEREUM, 4, Due), decided(4))).toBe(false)
      expect(Steps.epochAdvance.isDecidedAndIdle(epochState(ETHEREUM, 4), undefined)).toBe(false)
      expect(Steps.epochAdvance.isDecidedAndIdle(undefined, decided(4))).toBe(false)
    })
  })

  describe("awaitDecidedAndIdle", () => {
    it("waits through an undecided epoch and pending traffic, never adding traffic", async () => {
      jest
        .spyOn(Steps.contracts.sysio.epoch, "readEpochStates")
        .mockResolvedValueOnce(states({}, 5))
        .mockResolvedValueOnce(states({ [SOLANA]: epochState(SOLANA, 5, Due) }, 5))
        .mockResolvedValue(states({}, 6))
      const consensus = serveConsensus({ [SOLANA]: 4 }, { [SOLANA]: 5 }, { [SOLANA]: 6 }),
        notetraffic = stubNotetraffic()
      await underFakeTimers(
        expect(Steps.epochAdvance.awaitDecidedAndIdle(context(), SOLANA, 100)).resolves.toBeUndefined()
      )
      expect(consensus).toHaveBeenCalledTimes(3)
      expect(notetraffic).not.toHaveBeenCalled()
    })

    it("keeps polling through a transient read error", async () => {
      serveStates(states({}, 5))
      const consensus = serveConsensus(new Error("rpc reset"), { [ETHEREUM]: 5 })
      await underFakeTimers(
        expect(Steps.epochAdvance.awaitDecidedAndIdle(context(), ETHEREUM, 100)).resolves.toBeUndefined()
      )
      expect(consensus).toHaveBeenCalledTimes(2)
    })

    it("times out naming the chain when it never settles", async () => {
      serveStates(states({}, 5))
      serveConsensus({ [ETHEREUM]: 4 })
      await underFakeTimers(
        expect(Steps.epochAdvance.awaitDecidedAndIdle(context(), ETHEREUM, 100)).rejects.toThrow(
          `Timed out waiting for: the ${ETHEREUM} epoch is decided and the chain idle`
        )
      )
    })
  })

  describe("awaitEpochIndicesAdvanced", () => {
    it("keeps waiting while one chain alone has advanced, keeping the idle chain due, and resolves once every chain has", async () => {
      serveStates(states({ [ETHEREUM]: epochState(ETHEREUM, 5, Due) }))
      const notetraffic = stubNotetraffic(),
        reads = serveIndices(indices(5, 2), indices(5, 3))
      await underFakeTimers(
        expect(
          Steps.epochAdvance.awaitEpochIndicesAdvanced(context(), indices(4, 2), signal)
        ).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(2)
      expect(pumpedChains(notetraffic)).toEqual([SOLANA])
    })

    it("keeps polling through a transient index read error", async () => {
      serveStates(states())
      stubNotetraffic()
      const reads = serveIndices(new Error("rpc reset"), indices(5, 3))
      await underFakeTimers(
        expect(
          Steps.epochAdvance.awaitEpochIndicesAdvanced(context(), indices(4, 2), signal)
        ).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(2)
    })

    it("times out naming every chain's start index when a chain never advances", async () => {
      serveStates(states())
      stubNotetraffic()
      serveIndices(indices(9, 2))
      await underFakeTimers(
        expect(
          Steps.epochAdvance.awaitEpochIndicesAdvanced(context(), indices(4, 2), signal)
        ).rejects.toThrow(
          `Timed out waiting for: every outpost chain's current_epoch_index advances past ${ETHEREUM} 4, ${SOLANA} 2`
        )
      )
    })
  })

  describe("planRecordEpochIndices", () => {
    it("stores every chain's index under the snapshot's own key", async () => {
      const ctx = context(),
        step = Steps.epochAdvance.planRecordEpochIndices(
          Report.Actor.Sysio,
          "snapshot",
          "snapshot",
          {},
          "before"
        )
      serveIndices(indices(7, 3))
      expect(step.input).toEqual({
        kind: "EpochAdvanceSteps.RecordEpochIndicesInput",
        snapshotName: "before"
      })
      await step.runner(ctx, step.input, signal)
      expect(
        ctx.outputs.assert(Steps.epochAdvance.epochIndicesKey("before"))
      ).toEqual(indices(7, 3))
      expect(Steps.epochAdvance.epochIndicesKey("before").name).not.toBe(
        Steps.epochAdvance.epochIndicesKey("after").name
      )
    })

    it.each(OutpostChainCodenames)(
      "refuses a snapshot while %s has not started its epoch",
      async chain => {
        serveIndices({ ...indices(3, 3), [chain]: 0 })
        await expect(
          Steps.epochAdvance.runRecordEpochIndices(
            context(),
            {
              kind: "EpochAdvanceSteps.RecordEpochIndicesInput",
              snapshotName: "before"
            },
            signal
          )
        ).rejects.toThrow(
          new RegExp(`the ${chain} consensus epoch has not started`)
        )
      }
    )
  })

  describe("planVerifyEpochIndicesAdvanced", () => {
    it("waits for every chain to advance past the recorded snapshot", async () => {
      const ctx = context(),
        step = Steps.epochAdvance.planVerifyEpochIndicesAdvanced(
          Report.Actor.Sysio,
          "advanced",
          "advanced",
          {},
          "before"
        )
      ctx.outputs.set(
        Steps.epochAdvance.epochIndicesKey("before"),
        indices(4, 2)
      )
      serveStates(states())
      const notetraffic = stubNotetraffic(),
        reads = serveIndices(indices(4, 3), indices(5, 3))
      expect(step.input).toEqual({
        kind: "EpochAdvanceSteps.VerifyEpochIndicesAdvancedInput",
        snapshotName: "before"
      })
      await underFakeTimers(
        expect(step.runner(ctx, step.input, signal)).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(2)
      expect(pumpedChains(notetraffic)).toEqual([ETHEREUM, SOLANA])
    })

    it("fails when the snapshot was never recorded", async () => {
      await expect(
        Steps.epochAdvance.runVerifyEpochIndicesAdvanced(
          context(),
          {
            kind: "EpochAdvanceSteps.VerifyEpochIndicesAdvancedInput",
            snapshotName: "missing"
          },
          signal
        )
      ).rejects.toThrow(/missing/)
    })
  })
})
