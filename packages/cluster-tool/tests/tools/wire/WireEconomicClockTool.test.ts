import { SlugName, SysioContracts } from "@wireio/sdk-core"

import { describeOutpostChains, type PerOutpostChain } from "@wireio/cluster-tool-shared"
import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { Constants, ProtocolTiming } from "@wireio/cluster-tool/Constants"
import {
  Steps,
  type ClusterBuildContext
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { WireEconomicClockTool } from "@wireio/cluster-tool/tools/wire"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

type Reading = WireEconomicClockTool.Reading
type Observation = WireEconomicClockTool.Observation

/** The grid every test runs on: 120 s economic epochs from a fixed start. */
const GridStartMs = Date.UTC(2026, 10, 23, 0, 0, 0),
  EconomicDurationSec = 120,
  EconomicDurationMs = EconomicDurationSec * ProtocolTiming.MsPerSecond,
  ConsensusDurationSec = 60,
  /** Seconds a tick lands after its boundary in the fixture readings. */
  CrankLagMs = 5_000,
  signal = new AbortController().signal,
  /** The chain the fixtures pause and hold. */
  Held = Constants.ETHEREUM_CHAIN_CODENAME,
  /** The chain the fixtures keep running beside it. */
  Running = Constants.SOLANA_CHAIN_CODENAME

/** A chain stamp (zone-less UTC, millisecond precision) for epoch ms. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "")
}

/** The grid start of economic epoch `index`. */
function boundaryMs(index: number): number {
  return GridStartMs + (index - 1) * EconomicDurationMs
}

/** One chain's consensus reading at `index`, on the fixture rows' boundaries ({@link chainRow}). */
function consensusReading(
  index: number,
  paused: boolean,
  decided = false
): WireEconomicClockTool.ConsensusReading {
  return {
    epochIndex: index,
    epochStartMs: GridStartMs,
    trafficSinceMs: GridStartMs,
    dueAtMs: GridStartMs + ConsensusDurationSec * ProtocolTiming.MsPerSecond,
    paused,
    decided
  }
}

/**
 * A reading of economic epoch `index` on the grid, read `CrankLagMs` after it opened: the held
 * chain at `consensusEpochIndex` (paused when `consensusPaused`), the running chain at
 * `runningEpochIndex` and never paused.
 */
function reading(
  index: number,
  consensusEpochIndex: number,
  consensusPaused = false,
  headBlockTimeMs = boundaryMs(index) + CrankLagMs,
  runningEpochIndex = consensusEpochIndex
): Reading {
  return {
    economicEpochIndex: index,
    economicEpochStartMs: boundaryMs(index),
    economicNextEpochStartMs: boundaryMs(index + 1),
    consensus: {
      [Held]: consensusReading(consensusEpochIndex, consensusPaused),
      [Running]: consensusReading(runningEpochIndex, false)
    },
    headBlockTimeMs
  }
}

/** The `economycfg` row of the fixture grid. */
const GridConfig: SysioContracts.SysioEpochEconomicConfigType = {
  epoch_duration_sec: EconomicDurationSec,
  start_time: new Date(GridStartMs).toISOString().slice(0, 19)
}

/** The `economystate` row of economic epoch `index` on the fixture grid. */
function economyRow(index: number): SysioContracts.SysioEpochEconomicStateType {
  return {
    current_epoch_index: index,
    current_epoch_start: stamp(boundaryMs(index)),
    next_epoch_start: stamp(boundaryMs(index + 1)),
    caught_up: true
  }
}

/** A zero `time_point` as the chain renders it: no traffic. */
const NoTraffic = "1970-01-01T00:00:00.000"

/** One chain's whole `epochstate` row at consensus epoch `index`, with traffic since its start. */
function chainRow(
  chain: Constants.OutpostChainCodename,
  index: number,
  paused: boolean
): SysioContracts.SysioEpochEpochStateType {
  return {
    chain_code: SlugName.from(chain),
    current_epoch_index: index,
    current_epoch_start: stamp(GridStartMs),
    traffic_since: stamp(GridStartMs),
    due_at: stamp(GridStartMs + ConsensusDurationSec * ProtocolTiming.MsPerSecond),
    current_batch_op_group: 0,
    batch_op_groups: [],
    is_paused: paused,
    previous_group: []
  }
}

/** The `outpcons` read of a depot that has accepted no winner on any chain yet. */
const NoAcceptedWinner: PerOutpostChain<SysioContracts.SysioMsgchOutpostConsensusEntryType> = {
  [Held]: undefined,
  [Running]: undefined
}

/** No chain's current epoch was ever disputed. */
const NoCurrentDisputes: PerOutpostChain<SysioContracts.SysioChalgDisputeEntryType> = {
  [Held]: undefined,
  [Running]: undefined
}

/** One chain's `outpcons` row, recording the accepted winner of its epoch `index`. */
function outpostConsensusRow(
  chain: Constants.OutpostChainCodename,
  index: number
): SysioContracts.SysioMsgchOutpostConsensusEntryType {
  return {
    chain_code: SlugName.from(chain),
    epoch_index: index,
    consensus_reached: true,
    winning_checksum: "",
    envelope_digest: "",
    message_tip: "",
    previous_epoch_index: 0,
    previous_winning_checksum: ""
  }
}

/** One `disputes` row on `chain`'s epoch `index`. */
function disputeRow(
  chain: Constants.OutpostChainCodename,
  index: number,
  status: SysioContracts.SysioChalgDisputestatus
): SysioContracts.SysioChalgDisputeEntryType {
  return {
    id: 1,
    chain_code: SlugName.from(chain),
    epoch_index: index,
    status,
    winning_checksum: "",
    opened_at: stamp(GridStartMs),
    deadline: stamp(GridStartMs),
    candidates: [],
    network_gen: 0,
    electorate: [],
    quorum: 0
  }
}

/** Every chain's `epochstate` row: the held chain at `index` (paused when `paused`), the running one at `index`. */
function consensusRow(
  index: number,
  paused = false
): PerOutpostChain<SysioContracts.SysioEpochEpochStateType> {
  return { [Held]: chainRow(Held, index, paused), [Running]: chainRow(Running, index, false) }
}

/** The chain head the fixture reads report. */
type GetInfoResponse = Awaited<
  ReturnType<ClusterBuildContext["wire"]["getInfo"]>
>

/** A real context whose clock reads serve `economy`, every chain's `consensus` and `headMs`, one triple per read. */
function clockContext(
  reads: ReadonlyArray<
    [
      SysioContracts.SysioEpochEconomicStateType,
      PerOutpostChain<SysioContracts.SysioEpochEpochStateType>,
      number
    ]
  >
): ClusterBuildContext {
  const ctx = fixtureContext({ economicEpochDurationSec: EconomicDurationSec }),
    economy = jest.spyOn(Steps.contracts.sysio.epoch, "readEconomyState"),
    consensus = jest.spyOn(Steps.contracts.sysio.epoch, "readEpochStates"),
    info = jest.spyOn(ctx.wire, "getInfo")
  // No chain has an accepted winner or a dispute, so no epoch reads as decided.
  jest.spyOn(Steps.contracts.sysio.msgch, "readOutpostConsensus").mockResolvedValue(NoAcceptedWinner)
  jest.spyOn(Steps.contracts.sysio.chalg, "readEpochDispute").mockResolvedValue(undefined)
  reads.forEach(([economyState, consensusState, headMs]) => {
    economy.mockResolvedValueOnce(economyState)
    consensus.mockResolvedValueOnce(consensusState)
    info.mockResolvedValueOnce({
      head_block_time: stamp(headMs)
    } as GetInfoResponse)
  })
  return ctx
}

describe("WireEconomicClockTool", () => {
  afterEach(() => jest.restoreAllMocks())

  it("keys each observation by its name", () => {
    expect(WireEconomicClockTool.observationKey("held").name).toBe(
      `${WireEconomicClockTool.ObservationKeyPrefix}held`
    )
    expect(WireEconomicClockTool.observationKey("a").name).not.toBe(
      WireEconomicClockTool.observationKey("b").name
    )
  })

  describe("readReading", () => {
    it("reads both clocks and the chain head on the chain's own clock", async () => {
      const headMs = boundaryMs(4) + 7_000,
        ctx = clockContext([[economyRow(4), consensusRow(9, true), headMs]])
      await expect(WireEconomicClockTool.readReading(ctx)).resolves.toEqual({
        economicEpochIndex: 4,
        economicEpochStartMs: boundaryMs(4),
        economicNextEpochStartMs: boundaryMs(5),
        consensus: {
          [Held]: consensusReading(9, true),
          [Running]: consensusReading(9, false)
        },
        headBlockTimeMs: headMs
      })
    })

    it("before the first economic epoch, the next boundary is the grid's start", async () => {
      const ctx = clockContext([
        [undefined, consensusRow(1), GridStartMs + 1_000]
      ])
      jest
        .spyOn(Steps.contracts.sysio.epoch, "readEconomyConfig")
        .mockResolvedValue(GridConfig)
      const first = await WireEconomicClockTool.readReading(ctx)
      expect(first.economicEpochIndex).toBe(0)
      expect(first.economicEpochStartMs).toBeNull()
      expect(first.economicNextEpochStartMs).toBe(GridStartMs)
      expect(WireEconomicClockTool.isCaughtUp(first)).toBe(false)
    })

    it("refuses a depot missing a chain's consensus epoch state", async () => {
      const ctx = clockContext([
        [economyRow(1), { [Held]: chainRow(Held, 1, false), [Running]: undefined }, GridStartMs]
      ])
      await expect(WireEconomicClockTool.readReading(ctx)).rejects.toThrow(
        new RegExp(`epochstate has no ${Running} row`)
      )
    })

    it("reads each chain's consensus from its own row: index, start, traffic, due and pause", () => {
      const solanaStartMs = GridStartMs + 7 * ConsensusDurationSec * ProtocolTiming.MsPerSecond,
        trafficSinceMs = solanaStartMs + 90 * ProtocolTiming.MsPerSecond,
        running = {
          ...chainRow(Running, 3, false),
          current_epoch_start: stamp(solanaStartMs),
          traffic_since: stamp(trafficSinceMs),
          due_at: stamp(trafficSinceMs + ConsensusDurationSec * ProtocolTiming.MsPerSecond)
        }
      expect(
        WireEconomicClockTool.toConsensusReadings(
          {
            [Held]: chainRow(Held, 8, true),
            [Running]: running
          },
          NoAcceptedWinner,
          NoCurrentDisputes
        )
      ).toEqual({
        [Held]: consensusReading(8, true),
        [Running]: {
          epochIndex: 3,
          epochStartMs: solanaStartMs,
          trafficSinceMs,
          dueAtMs: trafficSinceMs + ConsensusDurationSec * ProtocolTiming.MsPerSecond,
          paused: false,
          decided: false
        }
      })
    })

    it("reads an idle chain's zero traffic and due as NoTrafficMs, and marks it idle", () => {
      const idle = { ...chainRow(Running, 3, false), traffic_since: NoTraffic, due_at: NoTraffic },
        readings = WireEconomicClockTool.toConsensusReadings(
          { [Held]: chainRow(Held, 8, false), [Running]: idle },
          NoAcceptedWinner,
          NoCurrentDisputes
        )
      expect(readings[Running].trafficSinceMs).toBe(Steps.contracts.sysio.epoch.NoTrafficMs)
      expect(readings[Running].dueAtMs).toBe(Steps.contracts.sysio.epoch.NoTrafficMs)
      expect(WireEconomicClockTool.isIdleReading(readings[Running])).toBe(true)
      expect(WireEconomicClockTool.isIdleReading(readings[Held])).toBe(false)
      expect(WireEconomicClockTool.describeConsensusReading(readings[Running])).toBe(
        `3${WireEconomicClockTool.IdleMark}`
      )
    })

    it("never reads a chain before its genesis advance as idle", () => {
      const genesis = { ...consensusReading(0, false), trafficSinceMs: 0, dueAtMs: 0 }
      expect(WireEconomicClockTool.isIdleReading(genesis)).toBe(false)
      expect(WireEconomicClockTool.describeConsensusReading(genesis)).toBe("0")
    })

    describe("a chain's current epoch is decided", () => {
      const { DISPUTE_STATUS_OPEN: Open, DISPUTE_STATUS_RESOLVED: Resolved } =
          SysioContracts.SysioChalgDisputestatus,
        states = { [Held]: chainRow(Held, 8, false), [Running]: chainRow(Running, 3, false) },
        decided = (
          outpostConsensus: PerOutpostChain<SysioContracts.SysioMsgchOutpostConsensusEntryType>,
          currentDisputes: PerOutpostChain<SysioContracts.SysioChalgDisputeEntryType> = NoCurrentDisputes
        ): PerOutpostChain<boolean> => {
          const readings = WireEconomicClockTool.toConsensusReadings(states, outpostConsensus, currentDisputes)
          return { [Held]: readings[Held].decided, [Running]: readings[Running].decided }
        },
        accepted = { [Held]: outpostConsensusRow(Held, 8), [Running]: outpostConsensusRow(Running, 3) }

      it("once outpcons records the winner of that epoch", () => {
        expect(decided(accepted)).toEqual({ [Held]: true, [Running]: true })
      })

      it("not while outpcons records the winner of an earlier epoch, or none", () => {
        expect(decided({ [Held]: outpostConsensusRow(Held, 7), [Running]: undefined })).toEqual({
          [Held]: false,
          [Running]: false
        })
      })

      it("not while a dispute on that epoch is open, but again once it is resolved", () => {
        expect(decided(accepted, { [Held]: disputeRow(Held, 8, Open), [Running]: undefined })).toEqual({
          [Held]: false,
          [Running]: true
        })
        expect(decided(accepted, { [Held]: disputeRow(Held, 8, Resolved), [Running]: undefined })).toEqual({
          [Held]: true,
          [Running]: true
        })
      })

      it("whatever open dispute is read for another chain or another epoch", () => {
        expect(
          decided(accepted, { [Held]: disputeRow(Held, 7, Open), [Running]: disputeRow(Held, 3, Open) })
        ).toEqual({ [Held]: true, [Running]: true })
      })
    })

    it("toConsensusReadings refuses a chain without an epochstate row", () => {
      expect(() =>
        WireEconomicClockTool.toConsensusReadings(
          {
            [Held]: undefined,
            [Running]: chainRow(Running, 3, false)
          },
          NoAcceptedWinner,
          NoCurrentDisputes
        )
      ).toThrow(new RegExp(`epochstate has no ${Held} row`))
    })

    it("readConsensusReadings reads epochstate and outpcons, then each chain's current-epoch dispute", async () => {
      const ctx = fixtureContext()
      jest.spyOn(Steps.contracts.sysio.epoch, "readEpochStates").mockResolvedValue({
        [Held]: chainRow(Held, 6, true),
        [Running]: chainRow(Running, 4, false)
      })
      jest
        .spyOn(Steps.contracts.sysio.msgch, "readOutpostConsensus")
        .mockResolvedValue({ [Held]: outpostConsensusRow(Held, 6), [Running]: outpostConsensusRow(Running, 4) })
      const epochDispute = jest
        .spyOn(Steps.contracts.sysio.chalg, "readEpochDispute")
        .mockImplementation(async (_ctx, chain, epochIndex) =>
          chain === Running
            ? disputeRow(Running, epochIndex, SysioContracts.SysioChalgDisputestatus.DISPUTE_STATUS_OPEN)
            : undefined
        )
      await expect(WireEconomicClockTool.readConsensusReadings(ctx)).resolves.toEqual({
        [Held]: consensusReading(6, true, true),
        [Running]: consensusReading(4, false, false)
      })
      expect(epochDispute).toHaveBeenCalledTimes(2)
      expect(epochDispute).toHaveBeenCalledWith(ctx, Held, 6)
      expect(epochDispute).toHaveBeenCalledWith(ctx, Running, 4)
    })

    it("readConsensusReadings reads no dispute for a chain without an epochstate row, and refuses it", async () => {
      const ctx = fixtureContext()
      jest
        .spyOn(Steps.contracts.sysio.epoch, "readEpochStates")
        .mockResolvedValue({ [Held]: chainRow(Held, 6, false), [Running]: undefined })
      jest.spyOn(Steps.contracts.sysio.msgch, "readOutpostConsensus").mockResolvedValue(NoAcceptedWinner)
      const epochDispute = jest.spyOn(Steps.contracts.sysio.chalg, "readEpochDispute").mockResolvedValue(undefined)
      await expect(WireEconomicClockTool.readConsensusReadings(ctx)).rejects.toThrow(
        new RegExp(`epochstate has no ${Running} row`)
      )
      expect(epochDispute).toHaveBeenCalledTimes(1)
    })

    it("readConsensusReadings fails with the read that fails", async () => {
      const ctx = fixtureContext()
      jest.spyOn(Steps.contracts.sysio.epoch, "readEpochStates").mockResolvedValue(consensusRow(6))
      jest.spyOn(Steps.contracts.sysio.msgch, "readOutpostConsensus").mockResolvedValue(NoAcceptedWinner)
      jest.spyOn(Steps.contracts.sysio.chalg, "readEpochDispute").mockRejectedValue(new Error("dispute read failed"))
      await expect(WireEconomicClockTool.readConsensusReadings(ctx)).rejects.toThrow(/dispute read failed/)
    })

    it("describes one chain's consensus for the log, marking a paused chain", () => {
      expect(WireEconomicClockTool.describeConsensusReading(consensusReading(8, true))).toBe(
        `8${WireEconomicClockTool.PausedMark}`
      )
      expect(WireEconomicClockTool.describeConsensusReading(consensusReading(3, false))).toBe("3")
      expect(
        describeOutpostChains(
          reading(1, 8, true, undefined, 3).consensus,
          WireEconomicClockTool.describeConsensusReading
        )
      ).toBe(`${Held} 8 (paused), ${Running} 3`)
    })

    it("refuses an economic clock that was never configured", async () => {
      const ctx = clockContext([[undefined, consensusRow(1), GridStartMs]])
      jest
        .spyOn(Steps.contracts.sysio.epoch, "readEconomyConfig")
        .mockResolvedValue(undefined)
      await expect(WireEconomicClockTool.readReading(ctx)).rejects.toThrow(
        /not configured/
      )
    })
  })

  it("isCaughtUp holds only while the next boundary is ahead of the chain head", () => {
    expect(WireEconomicClockTool.isCaughtUp(reading(3, 5))).toBe(true)
    expect(
      WireEconomicClockTool.isCaughtUp(reading(3, 5, false, boundaryMs(4)))
    ).toBe(false)
    expect(
      WireEconomicClockTool.isCaughtUp(reading(3, 5, false, boundaryMs(4) + 1))
    ).toBe(false)
  })

  it("readingsOf and latestReading follow the observation's order", () => {
    const start = reading(1, 1),
      ticks = [reading(2, 3), reading(3, 5)]
    expect(WireEconomicClockTool.readingsOf({ start, ticks })).toEqual([
      start,
      ...ticks
    ])
    expect(WireEconomicClockTool.latestReading({ start, ticks })).toBe(ticks[1])
    expect(WireEconomicClockTool.latestReading({ start, ticks: [] })).toBe(
      start
    )
  })

  it("sizes economic waits from the extension-inclusive economic epoch", () => {
    const epochMs =
      (EconomicDurationSec + ProtocolTiming.EpochExtensionMaxSec) * 1_000
    expect(WireEconomicClockTool.economicEpochWaitMs(EconomicDurationSec)).toBe(
      epochMs
    )
    expect(
      WireEconomicClockTool.awaitEconomicEpochsStepTimeoutMs(
        EconomicDurationSec,
        5
      )
    ).toBe(6 * epochMs + ProtocolTiming.PollDeadlineBufferMs)
  })

  describe("planAwaitEconomicEpochsOpened", () => {
    it("carries the count and the observation name to its named runner", () => {
      const step = WireEconomicClockTool.planAwaitEconomicEpochsOpened(
        Report.Actor.BatchOperator,
        "economic-epochs",
        "await",
        {},
        3,
        "clocks"
      )
      expect(step.input).toEqual({
        kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
        count: 3,
        observationName: "clocks",
        keepDueChains: []
      })
      expect(step.runner).toBe(
        WireEconomicClockTool.runAwaitEconomicEpochsOpened
      )
    })

    it("carries the chains it keeps due", () => {
      const step = WireEconomicClockTool.planAwaitEconomicEpochsOpened(
        Report.Actor.BatchOperator,
        "economic-epochs",
        "await",
        {},
        2,
        "clocks",
        [Running]
      )
      expect(step.input.keepDueChains).toEqual([Running])
    })

    it.each([0, -1, 1.5])("refuses to await %s economic epochs", count => {
      expect(() =>
        WireEconomicClockTool.planAwaitEconomicEpochsOpened(
          Report.Actor.BatchOperator,
          "economic-epochs",
          "await",
          {},
          count,
          "clocks"
        )
      ).toThrow(/at least one economic epoch/)
    })

    it("waits for the clock to catch up, then records each economic epoch as it opens", async () => {
      const ctx = clockContext([
        // Behind its grid: epoch 5's boundary has passed unopened.
        [economyRow(4), consensusRow(10), boundaryMs(5) + 1_000],
        [economyRow(5), consensusRow(11), boundaryMs(5) + CrankLagMs],
        [economyRow(6), consensusRow(13), boundaryMs(6) + CrankLagMs]
      ])
      const notetraffic = jest.spyOn(Steps.contracts.sysio.epoch, "runNotetraffic")
      await WireEconomicClockTool.runAwaitEconomicEpochsOpened(
        ctx,
        {
          kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
          count: 1,
          observationName: "clocks",
          keepDueChains: []
        },
        signal
      )
      expect(
        ctx.outputs.assert(WireEconomicClockTool.observationKey("clocks"))
      ).toEqual({
        start: reading(5, 11),
        ticks: [reading(6, 13)]
      })
      expect(notetraffic).not.toHaveBeenCalled()
    })

    it("keeps its chains due through the economic wait", async () => {
      const ctx = clockContext([
          [economyRow(5), consensusRow(11), boundaryMs(5) + CrankLagMs],
          [economyRow(5), consensusRow(11), boundaryMs(5) + 2 * CrankLagMs],
          [economyRow(6), consensusRow(12), boundaryMs(6) + CrankLagMs]
        ]),
        keepingDue = jest
          .spyOn(Steps.epochAdvance, "pollUntilKeepingDue")
          .mockImplementation(async (_ctx, _chains, _label, predicate) => {
            while (!(await predicate())) {
              /* each failed check would pump; the reads advance the fixture */
            }
          })
      await WireEconomicClockTool.runAwaitEconomicEpochsOpened(
        ctx,
        {
          kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
          count: 1,
          observationName: "clocks",
          keepDueChains: [Held, Running]
        },
        signal
      )
      expect(keepingDue).toHaveBeenCalledTimes(1)
      expect(keepingDue.mock.calls[0][0]).toBe(ctx)
      expect(keepingDue.mock.calls[0][1]).toEqual([Held, Running])
      expect(keepingDue.mock.calls[0][6]).toBe(signal)
      expect(
        ctx.outputs.assert(WireEconomicClockTool.observationKey("clocks")).ticks
      ).toEqual([reading(6, 12)])
    })

    it("an aborted await reads nothing", async () => {
      const ctx = fixtureContext(),
        economy = jest.spyOn(Steps.contracts.sysio.epoch, "readEconomyState")
      await expect(
        WireEconomicClockTool.runAwaitEconomicEpochsOpened(
          ctx,
          {
            kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
            count: 1,
            observationName: "clocks",
            keepDueChains: []
          },
          AbortSignal.abort()
        )
      ).rejects.toThrow()
      expect(economy).not.toHaveBeenCalled()
    })
  })

  it("planRecordClockReading stores one reading as an observation with no ticks", async () => {
    const ctx = clockContext([
        [economyRow(7), consensusRow(12, true), boundaryMs(7) + CrankLagMs]
      ]),
      step = WireEconomicClockTool.planRecordClockReading(
        Report.Actor.Sysio,
        "record",
        "record",
        {},
        "paused"
      )
    expect(step.input).toEqual({
      kind: "WireEconomicClockTool.RecordClockReadingInput",
      observationName: "paused"
    })
    await step.runner(ctx, step.input, signal)
    expect(
      ctx.outputs.assert(WireEconomicClockTool.observationKey("paused"))
    ).toEqual({
      start: reading(7, 12, true),
      ticks: []
    })
  })

  describe("assertEconomicGrid", () => {
    const onGrid: Observation = {
      start: reading(3, 4),
      ticks: [reading(4, 6), reading(5, 8)]
    }

    it("accepts economic epochs that open one at a time on their grid", () => {
      expect(() =>
        WireEconomicClockTool.assertEconomicGrid(GridConfig, onGrid)
      ).not.toThrow()
    })

    it("accepts a start read before the first economic epoch opened", () => {
      const start = {
        ...reading(0, 1),
        economicEpochStartMs: null,
        economicNextEpochStartMs: GridStartMs
      }
      expect(() =>
        WireEconomicClockTool.assertEconomicGrid(GridConfig, {
          start,
          ticks: [reading(1, 2)]
        })
      ).not.toThrow()
    })

    it("refuses an observation that saw no economic epoch open", () => {
      expect(() =>
        WireEconomicClockTool.assertEconomicGrid(GridConfig, {
          start: reading(3, 4),
          ticks: []
        })
      ).toThrow(/no economic epoch opened/)
    })

    it("refuses an epoch that starts off the grid", () => {
      const shifted = {
        ...reading(5, 8),
        economicEpochStartMs: boundaryMs(5) + 1_000
      }
      expect(() =>
        WireEconomicClockTool.assertEconomicGrid(GridConfig, {
          start: onGrid.start,
          ticks: [onGrid.ticks[0], shifted]
        })
      ).toThrow(/starts off the grid/)
    })

    it("refuses an epoch that does not span one duration", () => {
      const long = {
        ...reading(4, 6),
        economicNextEpochStartMs: boundaryMs(5) + 1_000
      }
      expect(() =>
        WireEconomicClockTool.assertEconomicGrid(GridConfig, {
          start: onGrid.start,
          ticks: [long]
        })
      ).toThrow(/does not span one 120 s duration/)
    })

    it("refuses epochs that did not open one at a time", () => {
      expect(() =>
        WireEconomicClockTool.assertEconomicGrid(GridConfig, {
          start: reading(3, 4),
          ticks: [reading(5, 8)]
        })
      ).toThrow(/one epoch at a time/)
    })

    it("refuses an epoch read open before its boundary", () => {
      expect(() =>
        WireEconomicClockTool.assertEconomicGrid(GridConfig, {
          start: reading(3, 4),
          ticks: [reading(4, 6, false, boundaryMs(4) - 1)]
        })
      ).toThrow(/before its boundary/)
    })

    it("planVerifyEconomicGrid asserts the stored observation against economycfg", async () => {
      const ctx = fixtureContext(),
        step = WireEconomicClockTool.planVerifyEconomicGrid(
          Report.Actor.Sysio,
          "grid",
          "grid",
          {},
          "clocks"
        )
      jest
        .spyOn(Steps.contracts.sysio.epoch, "readEconomyConfig")
        .mockResolvedValue(GridConfig)
      ctx.outputs.set(WireEconomicClockTool.observationKey("clocks"), onGrid)
      await expect(
        step.runner(ctx, step.input, signal)
      ).resolves.toBeUndefined()
      jest
        .spyOn(Steps.contracts.sysio.epoch, "readEconomyConfig")
        .mockResolvedValue({
          ...GridConfig,
          epoch_duration_sec: ConsensusDurationSec
        })
      await expect(step.runner(ctx, step.input, signal)).rejects.toThrow(
        /off the grid/
      )
    })
  })

  describe("assertConsensusHeld", () => {
    const paused: Observation = {
        start: reading(3, 9, true),
        ticks: [reading(4, 9, true)]
      },
      restarted: Observation = {
        start: reading(6, 9, true),
        ticks: [reading(7, 9, true)]
      }

    it("accepts one paused consensus epoch while the economic index grows", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld([paused, restarted], Held)
      ).not.toThrow()
    })

    it("holds only the named chain: the other chain may advance meanwhile", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld(
          [
            { start: reading(3, 9, true, undefined, 4), ticks: [reading(4, 9, true, undefined, 6)] }
          ],
          Held
        )
      ).not.toThrow()
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld([paused, restarted], Running)
      ).toThrow(new RegExp(`the ${Running} consensus was not paused`))
    })

    it("refuses a reading with consensus unpaused", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld(
          [paused, { start: reading(6, 9, true), ticks: [reading(7, 9)] }],
          Held
        )
      ).toThrow(/was not paused/)
    })

    it("refuses consensus that moved", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld(
          [paused, { start: reading(6, 10, true), ticks: [reading(7, 10, true)] }],
          Held
        )
      ).toThrow(/consensus moved from epoch 9/)
    })

    it("refuses an economic clock that opened no epoch", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld(
          [
            { start: reading(3, 9, true), ticks: [] },
            { start: reading(3, 9, true), ticks: [] }
          ],
          Held
        )
      ).toThrow(/opened no epoch/)
    })

    it("refuses an economic index that moved back", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld([restarted, paused], Held)
      ).toThrow(/moved back/)
    })

    it("planVerifyConsensusHeld asserts the named observations in order", async () => {
      const ctx = fixtureContext(),
        step = WireEconomicClockTool.planVerifyConsensusHeld(
          Report.Actor.Sysio,
          "held",
          "held",
          {},
          Held,
          ["paused", "restarted"]
        )
      ctx.outputs
        .set(WireEconomicClockTool.observationKey("paused"), paused)
        .set(WireEconomicClockTool.observationKey("restarted"), restarted)
      expect(step.input.observationNames).toEqual(["paused", "restarted"])
      expect(step.input.chain).toBe(Held)
      await expect(
        step.runner(ctx, step.input, signal)
      ).resolves.toBeUndefined()
      const reversed = {
        ...step.input,
        observationNames: ["restarted", "paused"]
      }
      await expect(step.runner(ctx, reversed, signal)).rejects.toThrow(
        /moved back/
      )
    })

    it("planVerifyConsensusHeld refuses an observation never recorded", async () => {
      const step = WireEconomicClockTool.planVerifyConsensusHeld(
        Report.Actor.Sysio,
        "held",
        "held",
        {},
        Held,
        ["missing"]
      )
      await expect(
        step.runner(fixtureContext(), step.input, signal)
      ).rejects.toThrow(/Missing asserted output/)
    })
  })

  describe("consensus advance", () => {
    const effectiveMs =
      ProtocolTiming.effectiveEpochSec(ConsensusDurationSec) *
      ProtocolTiming.MsPerSecond

    it("bounds the consensus epochs a window must hold by the effective consensus epoch", () => {
      expect(
        WireEconomicClockTool.consensusAdvanceLowerBound(
          effectiveMs - 1,
          ConsensusDurationSec
        )
      ).toBe(0)
      expect(
        WireEconomicClockTool.consensusAdvanceLowerBound(
          effectiveMs,
          ConsensusDurationSec
        )
      ).toBe(1)
      expect(
        WireEconomicClockTool.consensusAdvanceLowerBound(
          480_000,
          ConsensusDurationSec
        )
      ).toBe(5)
    })

    it("accepts and counts consensus advancing at least the bound", () => {
      expect(
        WireEconomicClockTool.assertConsensusAdvanced(
          reading(1, 2),
          reading(5, 10),
          Held,
          ConsensusDurationSec
        )
      ).toBe(8)
    })

    it("refuses a paused reading", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusAdvanced(
          reading(1, 2),
          reading(5, 10, true),
          Held,
          ConsensusDurationSec
        )
      ).toThrow(new RegExp(`the ${Held} consensus was paused`))
    })

    it("refuses a window shorter than one effective consensus epoch", () => {
      const from = reading(1, 2),
        to = reading(1, 3, false, from.headBlockTimeMs + effectiveMs - 1)
      expect(() =>
        WireEconomicClockTool.assertConsensusAdvanced(
          from,
          to,
          Held,
          ConsensusDurationSec
        )
      ).toThrow(new RegExp(`spans no whole 90 s ${Held} consensus epoch`))
    })

    it("bounds the consensus epochs a window can hold by the chain's minimum", () => {
      const minimumMs = ConsensusDurationSec * ProtocolTiming.MsPerSecond
      expect(WireEconomicClockTool.consensusAdvanceUpperBound(minimumMs - 1, ConsensusDurationSec)).toBe(1)
      expect(WireEconomicClockTool.consensusAdvanceUpperBound(minimumMs, ConsensusDurationSec)).toBe(2)
      expect(WireEconomicClockTool.consensusAdvanceUpperBound(480_000, ConsensusDurationSec)).toBe(9)
    })

    it("refuses consensus advancing faster than its minimum allows", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusAdvanced(
          reading(1, 2),
          reading(5, 12),
          Held,
          ConsensusDurationSec
        )
      ).toThrow(/allows at most 9/)
    })

    it("refuses consensus advancing fewer epochs than the bound", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusAdvanced(
          reading(1, 2),
          reading(5, 6),
          Held,
          ConsensusDurationSec
        )
      ).toThrow(/so at least 5/)
    })

    it("measures each chain against its own duration", () => {
      // The running chain advanced 2 over 480 s: enough at 150 s epochs, too few at 60 s.
      const from = reading(1, 2, false, undefined, 1),
        to = reading(5, 10, false, undefined, 3)
      expect(WireEconomicClockTool.assertConsensusAdvanced(from, to, Running, 150)).toBe(2)
      expect(() =>
        WireEconomicClockTool.assertConsensusAdvanced(from, to, Running, ConsensusDurationSec)
      ).toThrow(new RegExp(`the ${Running} consensus advanced 2 epoch`))
    })

    it("planVerifyConsensusAdvanced asserts a chain between two observations against its epochcfg duration", async () => {
      const ctx = fixtureContext(),
        step = WireEconomicClockTool.planVerifyConsensusAdvanced(
          Report.Actor.Sysio,
          "advanced",
          "advanced",
          {},
          Running,
          "before",
          "after"
        ),
        config = jest
          .spyOn(Steps.contracts.sysio.epoch, "readEpochDurationSec")
          .mockResolvedValue(ConsensusDurationSec)
      ctx.outputs
        .set(WireEconomicClockTool.observationKey("before"), { start: reading(1, 2, true), ticks: [] })
        .set(WireEconomicClockTool.observationKey("after"), {
          start: reading(5, 2, true, undefined, 10),
          ticks: []
        })
      expect(step.input).toEqual({
        kind: "WireEconomicClockTool.VerifyConsensusAdvancedInput",
        chain: Running,
        fromObservationName: "before",
        toObservationName: "after"
      })
      await expect(step.runner(ctx, step.input, signal)).resolves.toBeUndefined()
      expect(config).toHaveBeenCalledWith(ctx, Running)
      const held: WireEconomicClockTool.VerifyConsensusAdvancedInput = {
        ...step.input,
        chain: Held
      }
      await expect(step.runner(ctx, held, signal)).rejects.toThrow(/was paused/)
    })
  })
})

describe("WireEconomicClockTool.assertDueAt", () => {
  const MinimumSec = ConsensusDurationSec,
    TrafficWaitSec = ConsensusDurationSec / 2,
    MinimumMs = MinimumSec * ProtocolTiming.MsPerSecond,
    TrafficWaitMs = TrafficWaitSec * ProtocolTiming.MsPerSecond,
    StartMs = GridStartMs,
    /** The chain's `epochcfg` row: its minimum and the contract's default traffic wait (half). */
    Config: SysioContracts.SysioEpochEpochConfigType = {
      chain_code: String(SlugName.from(Held)),
      epoch_duration_sec: MinimumSec,
      traffic_wait_sec: TrafficWaitSec,
      late_window_sec: TrafficWaitSec,
      operators_per_epoch: 3,
      batch_operator_minimum_active: 9,
      batch_op_groups: 3,
      epoch_retention_envelope_log_count: 2
    }

  /** The chain at epoch 4, started at `StartMs`, with the given traffic and due time. */
  function dueReading(trafficSinceMs: number, dueAtMs: number): WireEconomicClockTool.ConsensusReading {
    return { epochIndex: 4, epochStartMs: StartMs, trafficSinceMs, dueAtMs, paused: false, decided: true }
  }

  it("passes a chain with traffic due one minimum after its start", () => {
    // Traffic before the start, or early in the epoch.
    WireEconomicClockTool.assertDueAt(dueReading(StartMs - 5_000, StartMs + MinimumMs), Config, Held)
    WireEconomicClockTool.assertDueAt(dueReading(StartMs + 7_000, StartMs + MinimumMs), Config, Held)
  })

  it("passes a chain whose late traffic makes it due one traffic wait after the traffic", () => {
    const lateMs = StartMs + MinimumMs - 1_000
    WireEconomicClockTool.assertDueAt(dueReading(lateMs, lateMs + TrafficWaitMs), Config, Held)
  })

  it("passes an idle chain with neither traffic nor a due_at", () => {
    WireEconomicClockTool.assertDueAt(
      dueReading(Steps.contracts.sysio.epoch.NoTrafficMs, Steps.contracts.sysio.epoch.NoTrafficMs),
      Config,
      Held
    )
  })

  it("fails a due_at off the rule", () => {
    const lateMs = StartMs + MinimumMs - 1_000
    // Due one minimum after the start, as if the late traffic waited nothing; then one full
    // minimum after the traffic, the rule before the traffic wait.
    ;[StartMs + MinimumMs, lateMs + MinimumMs].forEach(dueAtMs =>
      expect(() => WireEconomicClockTool.assertDueAt(dueReading(lateMs, dueAtMs), Config, Held)).toThrow(
        /ETHEREUM epoch 4 is not due at the later of its start plus its 60 s minimum and its traffic plus its 30 s wait/
      )
    )
  })

  it("fails an idle chain carrying a due_at", () => {
    expect(() =>
      WireEconomicClockTool.assertDueAt(
        dueReading(Steps.contracts.sysio.epoch.NoTrafficMs, StartMs + MinimumMs),
        Config,
        Held
      )
    ).toThrow(/ETHEREUM epoch 4 has no traffic yet is due at/)
  })
})

/** The real client's chain-time parser, reachable for the stamp helper's round trip. */
describe("fixture stamps", () => {
  it("round-trip through WireClient.chainTimeMs", () => {
    expect(WireClient.chainTimeMs(stamp(boundaryMs(3)))).toBe(boundaryMs(3))
  })
})
