import {
  OutpostChainCodename,
  OutpostChainCodenames,
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

  describe("planAwaitEpochAdvanced", () => {
    it("carries its chain to the named runner", () => {
      const step = Steps.epochAdvance.planAwaitEpochAdvanced(
        Report.Actor.Sysio,
        "gate",
        "gate",
        {},
        SOLANA
      )
      expect(step.input).toEqual({
        kind: "EpochAdvanceSteps.AwaitEpochAdvancedInput",
        chain: SOLANA
      })
      expect(step.runner).toBe(Steps.epochAdvance.runAwaitEpochAdvanced)
    })

    it("resolves once ITS chain reaches the target, whatever the other chain reads", async () => {
      const reads = serveIndices(
        indices(9, 1),
        indices(9, Steps.epochAdvance.BootstrapAdvanceTargetIndex)
      )
      await underFakeTimers(
        expect(
          Steps.epochAdvance.runAwaitEpochAdvanced(
            context(),
            {
              kind: "EpochAdvanceSteps.AwaitEpochAdvancedInput",
              chain: SOLANA
            },
            signal
          )
        ).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(2)
    })

    it("resolves on the first read when the chain is already past the target", async () => {
      const reads = serveIndices(indices(5, 0))
      await underFakeTimers(
        expect(
          Steps.epochAdvance.runAwaitEpochAdvanced(
            context(),
            {
              kind: "EpochAdvanceSteps.AwaitEpochAdvancedInput",
              chain: ETHEREUM
            },
            signal
          )
        ).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(1)
    })

    it("keeps polling through a transient read error", async () => {
      const reads = serveIndices(new Error("rpc reset"), indices(2, 2))
      await underFakeTimers(
        expect(
          Steps.epochAdvance.runAwaitEpochAdvanced(
            context(),
            {
              kind: "EpochAdvanceSteps.AwaitEpochAdvancedInput",
              chain: ETHEREUM
            },
            signal
          )
        ).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(2)
    })

    it("times out with the chain named when its epoch never reaches the target", async () => {
      serveIndices(indices(9, 1))
      await underFakeTimers(
        expect(
          Steps.epochAdvance.runAwaitEpochAdvanced(
            context(),
            {
              kind: "EpochAdvanceSteps.AwaitEpochAdvancedInput",
              chain: SOLANA
            },
            signal
          )
        ).rejects.toThrow(
          `Timed out waiting for: the ${SOLANA} current_epoch_index reaches ${Steps.epochAdvance.BootstrapAdvanceTargetIndex}`
        )
      )
    })

    it("refuses to run once aborted", async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(
        Steps.epochAdvance.runAwaitEpochAdvanced(
          context(),
          {
            kind: "EpochAdvanceSteps.AwaitEpochAdvancedInput",
            chain: ETHEREUM
          },
          controller.signal
        )
      ).rejects.toThrow()
    })
  })

  describe("awaitEpochIndicesAdvanced", () => {
    it("keeps waiting while one chain alone has advanced, and resolves once every chain has", async () => {
      const reads = serveIndices(indices(5, 2), indices(5, 3))
      await underFakeTimers(
        expect(
          Steps.epochAdvance.awaitEpochIndicesAdvanced(context(), indices(4, 2))
        ).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(2)
    })

    it("times out naming every chain's start index when a chain never advances", async () => {
      serveIndices(indices(9, 2))
      await underFakeTimers(
        expect(
          Steps.epochAdvance.awaitEpochIndicesAdvanced(context(), indices(4, 2))
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
      const reads = serveIndices(indices(4, 3), indices(5, 3))
      expect(step.input).toEqual({
        kind: "EpochAdvanceSteps.VerifyEpochIndicesAdvancedInput",
        snapshotName: "before"
      })
      await underFakeTimers(
        expect(step.runner(ctx, step.input, signal)).resolves.toBeUndefined()
      )
      expect(reads).toHaveBeenCalledTimes(2)
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
