import { SysioContracts } from "@wireio/sdk-core"

import { WireClient } from "@wireio/cluster-tool/clients/wire"
import { ProtocolTiming } from "@wireio/cluster-tool/Constants"
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
  signal = new AbortController().signal

/** A chain stamp (zone-less UTC, millisecond precision) for epoch ms. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace("Z", "")
}

/** The grid start of economic epoch `index`. */
function boundaryMs(index: number): number {
  return GridStartMs + (index - 1) * EconomicDurationMs
}

/** A reading of economic epoch `index` on the grid, read `CrankLagMs` after it opened. */
function reading(
  index: number,
  consensusEpochIndex: number,
  consensusPaused = false,
  headBlockTimeMs = boundaryMs(index) + CrankLagMs
): Reading {
  return {
    economicEpochIndex: index,
    economicEpochStartMs: boundaryMs(index),
    economicNextEpochStartMs: boundaryMs(index + 1),
    consensusEpochIndex,
    consensusPaused,
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
    next_epoch_start: stamp(boundaryMs(index + 1))
  }
}

/** An `epochstate` row at consensus epoch `index`. */
function consensusRow(
  index: number,
  paused = false
): SysioContracts.SysioEpochEpochStateType {
  return {
    current_epoch_index: index,
    is_paused: paused
  } as SysioContracts.SysioEpochEpochStateType
}

/** The chain head the fixture reads report. */
type GetInfoResponse = Awaited<
  ReturnType<ClusterBuildContext["wire"]["getInfo"]>
>

/** A real context whose clock reads serve `economy`, `consensus` and `headMs`, one triple per read. */
function clockContext(
  reads: ReadonlyArray<
    [
      SysioContracts.SysioEpochEconomicStateType,
      SysioContracts.SysioEpochEpochStateType,
      number
    ]
  >
): ClusterBuildContext {
  const ctx = fixtureContext({ economicEpochDurationSec: EconomicDurationSec }),
    economy = jest.spyOn(Steps.contracts.sysio.epoch, "readEconomyState"),
    consensus = jest.spyOn(Steps.contracts.sysio.epoch, "readEpochState"),
    info = jest.spyOn(ctx.wire, "getInfo")
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
        consensusEpochIndex: 9,
        consensusPaused: true,
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

    it("refuses a depot with no consensus epoch state", async () => {
      const ctx = clockContext([[economyRow(1), undefined, GridStartMs]])
      await expect(WireEconomicClockTool.readReading(ctx)).rejects.toThrow(
        /epochstate has no row/
      )
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
        observationName: "clocks"
      })
      expect(step.runner).toBe(
        WireEconomicClockTool.runAwaitEconomicEpochsOpened
      )
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
      await WireEconomicClockTool.runAwaitEconomicEpochsOpened(
        ctx,
        {
          kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
          count: 1,
          observationName: "clocks"
        },
        signal
      )
      expect(
        ctx.outputs.assert(WireEconomicClockTool.observationKey("clocks"))
      ).toEqual({
        start: reading(5, 11),
        ticks: [reading(6, 13)]
      })
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
            observationName: "clocks"
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
        WireEconomicClockTool.assertConsensusHeld([paused, restarted])
      ).not.toThrow()
    })

    it("refuses a reading with consensus unpaused", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld([
          paused,
          { start: reading(6, 9, true), ticks: [reading(7, 9)] }
        ])
      ).toThrow(/was not paused/)
    })

    it("refuses consensus that moved", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld([
          paused,
          { start: reading(6, 10, true), ticks: [reading(7, 10, true)] }
        ])
      ).toThrow(/consensus moved from epoch 9/)
    })

    it("refuses an economic clock that opened no epoch", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld([
          { start: reading(3, 9, true), ticks: [] },
          { start: reading(3, 9, true), ticks: [] }
        ])
      ).toThrow(/opened no epoch/)
    })

    it("refuses an economic index that moved back", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusHeld([restarted, paused])
      ).toThrow(/moved back/)
    })

    it("planVerifyConsensusHeld asserts the named observations in order", async () => {
      const ctx = fixtureContext(),
        step = WireEconomicClockTool.planVerifyConsensusHeld(
          Report.Actor.Sysio,
          "held",
          "held",
          {},
          ["paused", "restarted"]
        )
      ctx.outputs
        .set(WireEconomicClockTool.observationKey("paused"), paused)
        .set(WireEconomicClockTool.observationKey("restarted"), restarted)
      expect(step.input.observationNames).toEqual(["paused", "restarted"])
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
          ConsensusDurationSec
        )
      ).toBe(8)
    })

    it("refuses a paused reading", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusAdvanced(
          reading(1, 2),
          reading(5, 10, true),
          ConsensusDurationSec
        )
      ).toThrow(/was paused/)
    })

    it("refuses a window shorter than one effective consensus epoch", () => {
      const from = reading(1, 2),
        to = {
          ...from,
          consensusEpochIndex: 3,
          headBlockTimeMs: from.headBlockTimeMs + effectiveMs - 1
        }
      expect(() =>
        WireEconomicClockTool.assertConsensusAdvanced(
          from,
          to,
          ConsensusDurationSec
        )
      ).toThrow(/spans no whole 90 s consensus epoch/)
    })

    it("refuses consensus advancing fewer epochs than the bound", () => {
      expect(() =>
        WireEconomicClockTool.assertConsensusAdvanced(
          reading(1, 2),
          reading(5, 6),
          ConsensusDurationSec
        )
      ).toThrow(/so at least 5/)
    })
  })
})

/** The real client's chain-time parser, reachable for the stamp helper's round trip. */
describe("fixture stamps", () => {
  it("round-trip through WireClient.chainTimeMs", () => {
    expect(WireClient.chainTimeMs(stamp(boundaryMs(3)))).toBe(boundaryMs(3))
  })
})
