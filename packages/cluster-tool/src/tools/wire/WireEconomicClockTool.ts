/**
 * WireEconomicClockTool — the depot's two clocks, read and awaited together. The economic clock
 * (`sysio.epoch::economycfg` / `economystate`) is a fixed wall-clock grid the batch operators'
 * `tickeconomy` crank opens; emissions, collateral-withdrawal maturity and producer pay run on it,
 * and it never waits on outpost consensus. The consensus epoch (`epochstate`) advances only once
 * every active outpost has reached consensus, and stops while paused.
 *
 * {@link WireEconomicClockTool.planAwaitEconomicEpochsOpened} observes economic epochs open,
 * recording a {@link WireEconomicClockTool.Reading} of both clocks at each one, and
 * {@link WireEconomicClockTool.planRecordClockReading} records a single reading. The verify Steps
 * assert over what was observed: {@link WireEconomicClockTool.planVerifyEconomicGrid} (each
 * economic epoch opened on its own grid) and {@link WireEconomicClockTool.planVerifyConsensusHeld}
 * (consensus stayed paused at one index while the economic clock kept opening epochs).
 */

import Assert from "node:assert"

import type { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"

import { WireClient } from "../../clients/wire/WireClient.js"
import { ProtocolTiming } from "../../Constants.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import { outputKey, type OutputKey } from "../../orchestration/OutputStore.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { pollFor, pollUntil } from "../../orchestration/StepTools.js"
import { EpochContractSteps } from "../../orchestration/steps/contracts/sysio/EpochContractSteps.js"
import { Report } from "../../report/Report.js"

const log = getLogger(__filename)

/** Reads, awaits and verify Steps over the depot's economic clock and consensus epoch. */
export namespace WireEconomicClockTool {
  /**
   * Gap between clock reads (ms). Far below the 60 s floor of either clock, so an await sees
   * every economic epoch open on its own and a reading lands within seconds of the tick.
   */
  export const PollIntervalMs = 2_000

  /** Both clocks at one instant, every time in epoch ms on the chain's own clock. */
  export interface Reading {
    /** `economystate.current_epoch_index` — 0 before the first economic epoch opens. */
    readonly economicEpochIndex: number
    /** `economystate.current_epoch_start`; `null` before the first economic epoch opens. */
    readonly economicEpochStartMs: number
    /** When the next economic epoch may open: `economystate.next_epoch_start`, else `economycfg.start_time`. */
    readonly economicNextEpochStartMs: number
    /** `epochstate.current_epoch_index`. */
    readonly consensusEpochIndex: number
    /** `epochstate.is_paused` — a pause stops the consensus epoch only. */
    readonly consensusPaused: boolean
    /** The chain's `head_block_time` when the reading was taken. */
    readonly headBlockTimeMs: number
  }

  /**
   * What an await observed: the reading it started from, then one reading per economic epoch it
   * saw open, in order. A recorded reading is an observation with no ticks.
   */
  export interface Observation {
    /** The reading the observation started from (the clock caught up with its grid). */
    readonly start: Reading
    /** One reading per economic epoch seen opening, taken as it opened. */
    readonly ticks: readonly Reading[]
  }

  /** Name prefix of every {@link observationKey}; the observation's name follows it. */
  export const ObservationKeyPrefix = "WireEconomicClockTool.observation."

  /**
   * The `ctx.outputs` key an observation is stored under, one per name, so the Steps of one
   * scenario can keep several apart and a later verify Step can read them back.
   *
   * @param observationName - The observation's name within the scenario.
   * @returns The typed key.
   */
  export function observationKey(
    observationName: string
  ): OutputKey<Observation> {
    return outputKey<Observation>(
      `${ObservationKeyPrefix}${observationName}`,
      `the economic clock and consensus epoch readings observed as "${observationName}"`
    )
  }

  /**
   * READ both clocks and the chain head. Before the first economic epoch opens, the next
   * boundary is the grid's start (`economycfg.start_time`).
   *
   * @param ctx - The build context.
   * @returns The reading.
   * @throws When the consensus epoch or the economic clock is not configured.
   */
  export async function readReading<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<Reading> {
    const [economy, consensus, info] = await Promise.all([
      EpochContractSteps.readEconomyState(ctx),
      EpochContractSteps.readEpochState(ctx),
      ctx.wire.getInfo()
    ])
    Assert.ok(
      consensus != null,
      "WireEconomicClockTool: sysio.epoch::epochstate has no row"
    )
    return {
      economicEpochIndex: economy?.current_epoch_index ?? 0,
      economicEpochStartMs:
        economy != null
          ? WireClient.chainTimeMs(economy.current_epoch_start)
          : null,
      economicNextEpochStartMs:
        economy != null
          ? WireClient.chainTimeMs(economy.next_epoch_start)
          : await readGridStartMs(ctx),
      consensusEpochIndex: consensus.current_epoch_index,
      consensusPaused: Boolean(consensus.is_paused),
      headBlockTimeMs: WireClient.chainTimeMs(info.head_block_time)
    }
  }

  /** `economycfg.start_time` in epoch ms — the next boundary before the first economic epoch opens. */
  async function readGridStartMs<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<number> {
    const config = await EpochContractSteps.readEconomyConfig(ctx)
    Assert.ok(
      config != null,
      "WireEconomicClockTool: the economic clock is not configured"
    )
    return WireClient.chainTimeMs(config.start_time)
  }

  /**
   * Whether the economic clock is caught up with its grid: its next boundary is still ahead of the
   * chain head, so no due economic epoch is waiting for the crank. A clock behind its grid (a
   * start in the past, or a stalled crank) opens one epoch per `tickeconomy` until it is.
   *
   * @param reading - A reading of both clocks.
   * @returns `true` when no economic boundary has passed unopened.
   */
  export function isCaughtUp(reading: Reading): boolean {
    return reading.economicNextEpochStartMs > reading.headBlockTimeMs
  }

  /**
   * Every reading of an observation, in order: its start, then its ticks.
   *
   * @param observation - The observation.
   * @returns `[start, ...ticks]`.
   */
  export function readingsOf(observation: Observation): Reading[] {
    return [observation.start, ...observation.ticks]
  }

  /**
   * The latest reading of an observation: its last tick, else its start.
   *
   * @param observation - The observation.
   * @returns The reading taken last.
   */
  export function latestReading(observation: Observation): Reading {
    return observation.ticks.at(-1) ?? observation.start
  }

  /**
   * One economic epoch's wait (ms): its duration plus the delivery extension margin, which also
   * covers the crank poll between a boundary and the tick that opens it.
   *
   * @param economicEpochDurationSec - The cluster's economic epoch duration (s).
   * @returns The extension-inclusive wait for one economic epoch to open (ms).
   */
  export function economicEpochWaitMs(
    economicEpochDurationSec: number
  ): number {
    return (
      ProtocolTiming.effectiveEpochSec(economicEpochDurationSec) *
      ProtocolTiming.MsPerSecond
    )
  }

  /**
   * Economic epochs {@link planAwaitEconomicEpochsOpened} allows the clock to catch up with its
   * grid before it counts: one, since the batch operators' crank opens up to ten due epochs per
   * poll.
   */
  export const CatchUpEconomicEpochs = 1

  /**
   * The Step ceiling of {@link planAwaitEconomicEpochsOpened} (ms): {@link CatchUpEconomicEpochs}
   * for the clock to catch up with its grid, one per epoch awaited, and the poll deadline margin.
   *
   * @param economicEpochDurationSec - The cluster's economic epoch duration (s) — pass the value
   *   the runner reads as `ctx.config.economicEpochDurationSec`.
   * @param count - The economic epochs the Step awaits.
   * @returns The Step's `timeoutMs`.
   */
  export function awaitEconomicEpochsStepTimeoutMs(
    economicEpochDurationSec: number,
    count: number
  ): number {
    return (
      (count + CatchUpEconomicEpochs) *
        economicEpochWaitMs(economicEpochDurationSec) +
      ProtocolTiming.PollDeadlineBufferMs
    )
  }

  // ── Step: record a reading ────────────────────────────────────────────────

  /** Input for {@link planRecordClockReading}. */
  export interface RecordClockReadingInput extends StepInput {
    readonly kind: "WireEconomicClockTool.RecordClockReadingInput"
    /** The name the reading is stored under ({@link observationKey}). */
    readonly observationName: string
  }

  /**
   * Record both clocks now as an observation with no ticks — a read, carried by a Step because
   * a later Step compares against it.
   */
  export function planRecordClockReading<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    observationName: string
  ): ClusterBuildStep<C, RecordClockReadingInput> {
    return ClusterBuildStep.create<C, RecordClockReadingInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireEconomicClockTool.RecordClockReadingInput",
        observationName
      },
      runRecordClockReading
    )
  }

  /** Named runner — read both clocks and store them under {@link observationKey}. */
  export async function runRecordClockReading<C extends ClusterBuildContext>(
    ctx: C,
    input: RecordClockReadingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    ctx.outputs.set(observationKey(input.observationName), {
      start: await readReading(ctx),
      ticks: []
    })
  }

  // ── Step: await economic epochs opening ───────────────────────────────────

  /** Input for {@link planAwaitEconomicEpochsOpened}. */
  export interface AwaitEconomicEpochsOpenedInput extends StepInput {
    readonly kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput"
    /** The economic epochs that must open after the observation starts. */
    readonly count: number
    /** The name the observation is stored under ({@link observationKey}). */
    readonly observationName: string
  }

  /**
   * Wait for the economic clock to catch up with its grid, then for `count` more economic epochs
   * to open, recording a reading as each one opens. A poll, so the wait returns the moment the
   * last epoch opens; the observation it stores is what the verify Steps assert over. Pair it with
   * {@link awaitEconomicEpochsStepTimeoutMs} for the Step's `timeoutMs`.
   *
   * @throws If `count` is not a positive integer.
   */
  export function planAwaitEconomicEpochsOpened<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    count: number,
    observationName: string
  ): ClusterBuildStep<C, AwaitEconomicEpochsOpenedInput> {
    Assert.ok(
      Number.isInteger(count) && count >= 1,
      `WireEconomicClockTool: await at least one economic epoch, not ${count}`
    )
    return ClusterBuildStep.create<C, AwaitEconomicEpochsOpenedInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireEconomicClockTool.AwaitEconomicEpochsOpenedInput",
        count,
        observationName
      },
      runAwaitEconomicEpochsOpened
    )
  }

  /** Named runner — catch up, then poll until `count` economic epochs opened, recording each. */
  export async function runAwaitEconomicEpochsOpened<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: AwaitEconomicEpochsOpenedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const epochWaitMs = economicEpochWaitMs(
        ctx.config.economicEpochDurationSec
      ),
      start = await pollFor(
        "the economic clock catches up with its grid",
        async () => {
          const reading = await readReading(ctx)
          return isCaughtUp(reading) ? reading : null
        },
        CatchUpEconomicEpochs * epochWaitMs,
        PollIntervalMs
      ),
      ticks: Reading[] = []
    await pollUntil(
      `${input.count} economic epoch(s) open after economic epoch ${start.economicEpochIndex}`,
      async () => {
        const reading = await readReading(ctx),
          previous = ticks.at(-1) ?? start
        if (reading.economicEpochIndex > previous.economicEpochIndex) {
          ticks.push(reading)
          log.info(
            `[economic-clock] economic epoch ${reading.economicEpochIndex} opened ` +
              `(${new Date(reading.economicEpochStartMs).toISOString()}); consensus epoch ` +
              `${reading.consensusEpochIndex}${reading.consensusPaused ? " (paused)" : ""}`
          )
        }
        return (
          latestReading({ start, ticks }).economicEpochIndex -
            start.economicEpochIndex >=
          input.count
        )
      },
      input.count * epochWaitMs,
      PollIntervalMs
    )
    ctx.outputs.set(observationKey(input.observationName), { start, ticks })
  }

  // ── Verify: the economic grid ─────────────────────────────────────────────

  /** Input for {@link planVerifyEconomicGrid}. */
  export interface VerifyEconomicGridInput extends StepInput {
    readonly kind: "WireEconomicClockTool.VerifyEconomicGridInput"
    /** The observation to verify ({@link observationKey}). */
    readonly observationName: string
  }

  /**
   * Assert every economic epoch the observation saw opened on the clock's own grid
   * ({@link assertEconomicGrid}): epoch N starts at `start_time + (N - 1) × duration`, spans
   * exactly one duration, and the epochs opened one at a time, each no earlier than its boundary.
   */
  export function planVerifyEconomicGrid<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    observationName: string
  ): ClusterBuildStep<C, VerifyEconomicGridInput> {
    return ClusterBuildStep.create<C, VerifyEconomicGridInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireEconomicClockTool.VerifyEconomicGridInput",
        observationName
      },
      runVerifyEconomicGrid
    )
  }

  /** Named runner — read `economycfg` and assert the stored observation against its grid. */
  export async function runVerifyEconomicGrid<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyEconomicGridInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const config = await EpochContractSteps.readEconomyConfig(ctx)
    Assert.ok(
      config != null,
      "WireEconomicClockTool: the economic clock is not configured"
    )
    assertEconomicGrid(
      config,
      ctx.outputs.assert(observationKey(input.observationName))
    )
  }

  /**
   * Assert an observation's economic epochs lie on the grid `config` defines. Every opened epoch
   * N (its start, and each tick) starts at `start_time + (N - 1) × epoch_duration_sec` and its next
   * boundary is one duration later; each tick opens exactly the epoch after the previous reading,
   * at or after its boundary on the chain's clock.
   *
   * @param config - The `economycfg` row.
   * @param observation - The observation to check.
   * @throws When the observation saw no economic epoch open, or any reading is off the grid.
   */
  export function assertEconomicGrid(
    config: SysioContracts.SysioEpochEconomicConfigType,
    observation: Observation
  ): void {
    const gridStartMs = WireClient.chainTimeMs(config.start_time),
      durationMs = config.epoch_duration_sec * ProtocolTiming.MsPerSecond
    Assert.ok(
      observation.ticks.length >= 1,
      "WireEconomicClockTool: no economic epoch opened"
    )
    readingsOf(observation)
      .filter(reading => reading.economicEpochIndex >= 1)
      .forEach(reading => {
        Assert.strictEqual(
          reading.economicEpochStartMs,
          gridStartMs + (reading.economicEpochIndex - 1) * durationMs,
          `economic epoch ${reading.economicEpochIndex} starts off the grid of ${config.epoch_duration_sec} s epochs from ${config.start_time}`
        )
        Assert.strictEqual(
          reading.economicNextEpochStartMs - reading.economicEpochStartMs,
          durationMs,
          `economic epoch ${reading.economicEpochIndex} does not span one ${config.epoch_duration_sec} s duration`
        )
      })
    observation.ticks.forEach((tick, index) => {
      const previous =
        index === 0 ? observation.start : observation.ticks[index - 1]
      Assert.strictEqual(
        tick.economicEpochIndex,
        previous.economicEpochIndex + 1,
        `economic epoch ${tick.economicEpochIndex} opened right after ${previous.economicEpochIndex}; the clock opens one epoch at a time`
      )
      Assert.ok(
        tick.headBlockTimeMs >= tick.economicEpochStartMs,
        `economic epoch ${tick.economicEpochIndex} was read open before its boundary`
      )
    })
  }

  // ── Verify: consensus held while the economic clock runs ─────────────────

  /** Input for {@link planVerifyConsensusHeld}. */
  export interface VerifyConsensusHeldInput extends StepInput {
    readonly kind: "WireEconomicClockTool.VerifyConsensusHeldInput"
    /** The observations that must all show the same paused consensus epoch, in order. */
    readonly observationNames: readonly string[]
  }

  /**
   * Assert consensus stayed paused at one index across every reading of the named observations,
   * while the economic clock kept opening epochs ({@link assertConsensusHeld}).
   */
  export function planVerifyConsensusHeld<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    observationNames: readonly string[]
  ): ClusterBuildStep<C, VerifyConsensusHeldInput> {
    return ClusterBuildStep.create<C, VerifyConsensusHeldInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireEconomicClockTool.VerifyConsensusHeldInput",
        observationNames
      },
      runVerifyConsensusHeld
    )
  }

  /** Named runner — assert the stored observations with {@link assertConsensusHeld}. */
  export async function runVerifyConsensusHeld<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyConsensusHeldInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertConsensusHeld(
      input.observationNames.map(observationName =>
        ctx.outputs.assert(observationKey(observationName))
      )
    )
  }

  /**
   * Assert every reading of `observations`, taken in order, shows consensus paused at one index,
   * while the economic epoch index never moved back and ended above where it started — the
   * economic clock kept running while consensus was held.
   *
   * @param observations - The observations, in the order they were taken.
   * @throws When consensus was unpaused or moved, or the economic clock opened no epoch.
   */
  export function assertConsensusHeld(
    observations: readonly Observation[]
  ): void {
    const readings = observations.flatMap(readingsOf)
    Assert.ok(
      readings.length >= 2,
      "WireEconomicClockTool: too few readings to compare"
    )
    const [first] = readings,
      last = readings.at(-1)
    readings.forEach(reading => {
      Assert.ok(
        reading.consensusPaused,
        `consensus was not paused at economic epoch ${reading.economicEpochIndex}`
      )
      Assert.strictEqual(
        reading.consensusEpochIndex,
        first.consensusEpochIndex,
        `consensus moved from epoch ${first.consensusEpochIndex} while it was held`
      )
    })
    readings
      .slice(1)
      .forEach((reading, index) =>
        Assert.ok(
          reading.economicEpochIndex >= readings[index].economicEpochIndex,
          `the economic epoch index moved back from ${readings[index].economicEpochIndex} to ${reading.economicEpochIndex}`
        )
      )
    Assert.ok(
      last.economicEpochIndex > first.economicEpochIndex,
      `the economic clock opened no epoch while consensus was held at epoch ${first.consensusEpochIndex}`
    )
  }

  // ── Pure: consensus advance ───────────────────────────────────────────────

  /**
   * The fewest consensus epochs that must close within a window: every consensus epoch closes
   * within its duration plus the delivery extension ({@link ProtocolTiming.effectiveEpochSec}), so
   * a window of length W holds at least `floor(W / effective)` closes.
   *
   * @param windowMs - The window's length on the chain's clock (ms).
   * @param consensusEpochDurationSec - The cluster's consensus epoch duration (s).
   * @returns The lower bound on the consensus epochs the window advances.
   */
  export function consensusAdvanceLowerBound(
    windowMs: number,
    consensusEpochDurationSec: number
  ): number {
    return Math.floor(
      windowMs /
        (ProtocolTiming.effectiveEpochSec(consensusEpochDurationSec) *
          ProtocolTiming.MsPerSecond)
    )
  }

  /**
   * Assert consensus ran unpaused from `from` to `to` and advanced at least
   * {@link consensusAdvanceLowerBound} epochs over the window between them.
   *
   * @param from - The earlier reading.
   * @param to - The later reading.
   * @param consensusEpochDurationSec - The cluster's consensus epoch duration (s).
   * @returns The consensus epochs advanced between the readings.
   * @throws When either reading shows consensus paused, the window is shorter than one effective
   *   consensus epoch (nothing could be measured), or consensus advanced fewer epochs than the bound.
   */
  export function assertConsensusAdvanced(
    from: Reading,
    to: Reading,
    consensusEpochDurationSec: number
  ): number {
    Assert.ok(
      !from.consensusPaused && !to.consensusPaused,
      `consensus was paused between consensus epochs ${from.consensusEpochIndex} and ${to.consensusEpochIndex}`
    )
    const windowMs = to.headBlockTimeMs - from.headBlockTimeMs,
      lowerBound = consensusAdvanceLowerBound(
        windowMs,
        consensusEpochDurationSec
      ),
      advanced = to.consensusEpochIndex - from.consensusEpochIndex
    Assert.ok(
      lowerBound >= 1,
      `a ${windowMs} ms window spans no whole ${ProtocolTiming.effectiveEpochSec(consensusEpochDurationSec)} s consensus epoch`
    )
    Assert.ok(
      advanced >= lowerBound,
      `consensus advanced ${advanced} epoch(s) in ${windowMs} ms; a consensus epoch closes within ` +
        `${ProtocolTiming.effectiveEpochSec(consensusEpochDurationSec)} s, so at least ${lowerBound}`
    )
    return advanced
  }
}
