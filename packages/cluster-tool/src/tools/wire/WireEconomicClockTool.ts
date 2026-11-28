/**
 * WireEconomicClockTool — the depot's two clocks, read and awaited together. The economic clock
 * (`sysio.epoch::economycfg` / `economystate`) is a fixed wall-clock grid the batch operators'
 * `tickeconomy` crank opens; emissions, collateral-withdrawal maturity and producer pay run on it,
 * and it never waits on outpost consensus. Each outpost chain runs its own depot-paced consensus
 * epoch (its `epochstate` row): it advances only once that outpost has reached consensus and the
 * chain is due — it has traffic, its minimum duration has passed since its epoch start and its
 * traffic wait (`epochcfg.traffic_wait_sec`) since that traffic — so an idle chain stays in its
 * epoch, and it stops while it is paused.
 *
 * {@link WireEconomicClockTool.planAwaitEconomicEpochsOpened} observes economic epochs open,
 * recording a {@link WireEconomicClockTool.Reading} of both clocks at each one, and
 * {@link WireEconomicClockTool.planRecordClockReading} records a single reading. The verify Steps
 * assert over what was observed: {@link WireEconomicClockTool.planVerifyEconomicGrid} (each
 * economic epoch opened on its own grid) and {@link WireEconomicClockTool.planVerifyConsensusHeld}
 * (one chain's consensus stayed paused at one index while the economic clock kept opening epochs).
 */

import Assert from "node:assert"

import { asOption } from "@3fv/prelude-ts"
import type { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"

import {
  describeOutpostChains,
  mapOutpostChains,
  OutpostChainCodenames,
  type PerOutpostChain
} from "@wireio/cluster-tool-shared"

import { WireClient } from "../../clients/wire/WireClient.js"
import { Constants, ProtocolTiming } from "../../Constants.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import { outputKey, type OutputKey } from "../../orchestration/OutputStore.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { pollFor } from "../../orchestration/StepTools.js"
import { EpochAdvanceSteps } from "../../orchestration/steps/EpochAdvanceSteps.js"
import { ChalgContractSteps } from "../../orchestration/steps/contracts/sysio/ChalgContractSteps.js"
import { EpochContractSteps } from "../../orchestration/steps/contracts/sysio/EpochContractSteps.js"
import { MsgchContractSteps } from "../../orchestration/steps/contracts/sysio/MsgchContractSteps.js"
import { Report } from "../../report/Report.js"

const log = getLogger(__filename)

/** Reads, awaits and verify Steps over the depot's economic clock and each chain's consensus epoch. */
export namespace WireEconomicClockTool {
  /**
   * Gap between clock reads (ms). Far below the economic clock's 60 s floor and a chain's 10 s
   * consensus floor, so an await sees
   * every economic epoch open on its own and a reading lands within seconds of the tick.
   */
  export const PollIntervalMs = 2_000

  /** One outpost chain's consensus epoch at one instant (its `epochstate` row). */
  export interface ConsensusReading {
    /** The chain's `epochstate.current_epoch_index`. */
    readonly epochIndex: number
    /**
     * The chain's `epochstate.current_epoch_start` in epoch ms on the chain's clock — the time of
     * the advance that opened the epoch.
     */
    readonly epochStartMs: number
    /**
     * The chain's `epochstate.traffic_since` in epoch ms — when its pending traffic began;
     * `EpochContractSteps.NoTrafficMs` while it has none.
     */
    readonly trafficSinceMs: number
    /**
     * The chain's `epochstate.due_at` in epoch ms — when it may next advance;
     * `EpochContractSteps.NoTrafficMs` while it is idle, since an idle chain is never due.
     */
    readonly dueAtMs: number
    /** The chain's `epochstate.is_paused` — a pause stops that chain's consensus epoch only. */
    readonly paused: boolean
    /**
     * Whether the chain's current epoch is decided: `sysio.msgch::outpcons` records its accepted
     * winner and no `sysio.chalg` dispute on it is open.
     */
    readonly decided: boolean
  }

  /** Every outpost chain's consensus epoch at one instant, keyed by its codename. */
  export type ConsensusReadings = Readonly<PerOutpostChain<ConsensusReading>>

  /** Both clocks at one instant, every time in epoch ms on the chain's own clock. */
  export interface Reading {
    /** `economystate.current_epoch_index` — 0 before the first economic epoch opens. */
    readonly economicEpochIndex: number
    /** `economystate.current_epoch_start`; `null` before the first economic epoch opens. */
    readonly economicEpochStartMs: number
    /** When the next economic epoch may open: `economystate.next_epoch_start`, else `economycfg.start_time`. */
    readonly economicNextEpochStartMs: number
    /** Every outpost chain's consensus epoch. */
    readonly consensus: ConsensusReadings
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
   * Every outpost chain's consensus epoch from its `epochstate` and `outpcons` rows and the dispute
   * on its current epoch — pure over the rows.
   *
   * @param states - Each outpost chain's `sysio.epoch::epochstate` row
   *   (`EpochContractSteps.readEpochStates`).
   * @param outpostConsensus - Each outpost chain's `sysio.msgch::outpcons` row, absent before its
   *   first accepted winner (`MsgchContractSteps.readOutpostConsensus`).
   * @param currentDisputes - Each outpost chain's `sysio.chalg::disputes` row on its current epoch,
   *   absent when that epoch was never disputed (`ChalgContractSteps.readEpochDispute`).
   * @returns Each outpost chain's consensus reading.
   * @throws When an outpost chain has no `epochstate` row.
   */
  export function toConsensusReadings(
    states: Readonly<PerOutpostChain<SysioContracts.SysioEpochEpochStateType>>,
    outpostConsensus: Readonly<PerOutpostChain<SysioContracts.SysioMsgchOutpostConsensusEntryType>>,
    currentDisputes: Readonly<PerOutpostChain<SysioContracts.SysioChalgDisputeEntryType>>
  ): ConsensusReadings {
    return mapOutpostChains(chain => {
      const row = states[chain]
      Assert.ok(
        row != null,
        `WireEconomicClockTool: sysio.epoch::epochstate has no ${chain} row`
      )
      const epochIndex = row.current_epoch_index,
        accepted = outpostConsensus[chain]?.epoch_index === epochIndex,
        dispute = currentDisputes[chain],
        disputed = dispute != null && ChalgContractSteps.isOpenDispute(dispute, chain, epochIndex)
      return {
        epochIndex,
        epochStartMs: WireClient.chainTimeMs(row.current_epoch_start),
        trafficSinceMs: EpochContractSteps.trafficSinceMs(row),
        dueAtMs: EpochContractSteps.dueAtMs(row),
        paused: row.is_paused,
        decided: accepted && !disputed
      }
    })
  }

  /**
   * READ every outpost chain's consensus epoch: its `epochstate` and `outpcons` rows, then the
   * dispute on its current epoch through the `byoutepoch` index, so the read stays one row per chain
   * however many disputes the depot holds.
   *
   * @param ctx - The build context.
   * @returns Each outpost chain's consensus reading.
   * @throws When an outpost chain has no `epochstate` row, or a read is truncated.
   */
  export async function readConsensusReadings<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<ConsensusReadings> {
    const [states, outpostConsensus] = await Promise.all([
        EpochContractSteps.readEpochStates(ctx),
        MsgchContractSteps.readOutpostConsensus(ctx)
      ]),
      disputes = await Promise.all(
        OutpostChainCodenames.map(chain =>
          asOption(states[chain])
            .map(state => ChalgContractSteps.readEpochDispute(ctx, chain, state.current_epoch_index))
            .getOrUndefined()
        )
      )
    return toConsensusReadings(
      states,
      outpostConsensus,
      mapOutpostChains(chain => disputes[OutpostChainCodenames.indexOf(chain)])
    )
  }

  /**
   * READ both clocks and the chain head. Before the first economic epoch opens, the next
   * boundary is the grid's start (`economycfg.start_time`).
   *
   * @param ctx - The build context.
   * @returns The reading.
   * @throws When an outpost chain's consensus epoch or the economic clock is not configured.
   */
  export async function readReading<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<Reading> {
    const [economy, consensus, info] = await Promise.all([
      EpochContractSteps.readEconomyState(ctx),
      readConsensusReadings(ctx),
      ctx.wire.getInfo()
    ])
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
      consensus,
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

  /** The mark {@link describeConsensusReading} puts after a paused chain's epoch index. */
  export const PausedMark = " (paused)"

  /**
   * The mark {@link describeConsensusReading} puts after an idle chain's epoch index: started,
   * unpaused, with no traffic, so it stays in its epoch until traffic arrives.
   */
  export const IdleMark = " (idle)"

  /**
   * Whether a reading shows its chain idle: started, with no traffic (`due_at` zero) — pure.
   *
   * @param reading - One outpost chain's consensus reading.
   * @returns True for a started chain with no traffic.
   */
  export function isIdleReading(reading: ConsensusReading): boolean {
    return reading.epochIndex > 0 && reading.dueAtMs === EpochContractSteps.NoTrafficMs
  }

  /**
   * Assert a chain's `due_at` follows its `epochcfg` — pure: an idle chain has neither traffic nor
   * a `due_at`; a chain with traffic is due exactly at the later of its epoch start plus its
   * minimum duration and its traffic plus its traffic wait.
   *
   * @param reading - The chain's consensus reading.
   * @param config - The chain's `epochcfg` row: its minimum and its traffic wait (s).
   * @param chain - The chain (for the message).
   * @throws When an idle chain carries a `due_at`, or a chain with traffic is due at another time.
   */
  export function assertDueAt(
    reading: ConsensusReading,
    config: SysioContracts.SysioEpochEpochConfigType,
    chain: Constants.OutpostChainCodename
  ): void {
    if (reading.trafficSinceMs === EpochContractSteps.NoTrafficMs) {
      Assert.strictEqual(
        reading.dueAtMs,
        EpochContractSteps.NoTrafficMs,
        `the ${chain} epoch ${reading.epochIndex} has no traffic yet is due at ${new Date(reading.dueAtMs).toISOString()}`
      )
      return
    }
    const { epoch_duration_sec: minimumSec, traffic_wait_sec: trafficWaitSec } = config
    Assert.strictEqual(
      reading.dueAtMs,
      Math.max(
        reading.epochStartMs + minimumSec * ProtocolTiming.MsPerSecond,
        reading.trafficSinceMs + trafficWaitSec * ProtocolTiming.MsPerSecond
      ),
      `the ${chain} epoch ${reading.epochIndex} is not due at the later of its start plus its ${minimumSec} s ` +
        `minimum and its traffic plus its ${trafficWaitSec} s wait`
    )
  }

  /**
   * One chain's consensus reading as text — its epoch index, marked when the chain is paused
   * (`2 (paused)`), else when it is idle (`3 (idle)`). The per-chain describer of
   * `describeOutpostChains`, which spells every chain's alike: `ETHEREUM 4 (idle), SOLANA 2 (paused)`.
   *
   * @param reading - One outpost chain's consensus reading.
   * @returns The chain's fragment.
   */
  export function describeConsensusReading(reading: ConsensusReading): string {
    const mark = reading.paused ? PausedMark : isIdleReading(reading) ? IdleMark : ""
    return `${reading.epochIndex}${mark}`
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
    /**
     * The outpost chains the await keeps due while it counts (`EpochAdvanceSteps.keepChainsDue`),
     * so their consensus advances over the observation; empty to leave every chain to its own
     * traffic (an idle chain then stays in its epoch).
     */
    readonly keepDueChains: readonly Constants.OutpostChainCodename[]
  }

  /**
   * Wait for the economic clock to catch up with its grid, then for `count` more economic epochs
   * to open, recording a reading as each one opens, and keeping `keepDueChains` due meanwhile. A
   * poll, so the wait returns the moment the last epoch opens; the observation it stores is what
   * the verify Steps assert over. Pair it with {@link awaitEconomicEpochsStepTimeoutMs} for the
   * Step's `timeoutMs`.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param count - The economic epochs that must open after the observation starts.
   * @param observationName - The name the observation is stored under.
   * @param keepDueChains - The chains whose consensus the await keeps due (none by default).
   * @returns The await step.
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
    observationName: string,
    keepDueChains: readonly Constants.OutpostChainCodename[] = []
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
        observationName,
        keepDueChains
      },
      runAwaitEconomicEpochsOpened
    )
  }

  /**
   * Named runner — catch up, then poll until `count` economic epochs opened, recording each and
   * keeping the input's chains due (`EpochAdvanceSteps.pollUntilKeepingDue`).
   */
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
    await EpochAdvanceSteps.pollUntilKeepingDue(
      ctx,
      input.keepDueChains,
      `${input.count} economic epoch(s) open after economic epoch ${start.economicEpochIndex}`,
      async () => {
        const reading = await readReading(ctx),
          previous = ticks.at(-1) ?? start
        if (reading.economicEpochIndex > previous.economicEpochIndex) {
          ticks.push(reading)
          log.info(
            `[economic-clock] economic epoch ${reading.economicEpochIndex} opened ` +
              `(${new Date(reading.economicEpochStartMs).toISOString()}); consensus ` +
              describeOutpostChains(reading.consensus, describeConsensusReading)
          )
        }
        return (
          latestReading({ start, ticks }).economicEpochIndex -
            start.economicEpochIndex >=
          input.count
        )
      },
      input.count * epochWaitMs,
      PollIntervalMs,
      signal
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

  // ── Verify: one chain's consensus held while the economic clock runs ──────

  /** Input for {@link planVerifyConsensusHeld}. */
  export interface VerifyConsensusHeldInput extends StepInput {
    readonly kind: "WireEconomicClockTool.VerifyConsensusHeldInput"
    /** The outpost chain whose consensus epoch was held. */
    readonly chain: Constants.OutpostChainCodename
    /** The observations that must all show the chain's consensus paused at one epoch, in order. */
    readonly observationNames: readonly string[]
  }

  /**
   * Assert one chain's consensus stayed paused at one index across every reading of the named
   * observations, while the economic clock kept opening epochs ({@link assertConsensusHeld}).
   */
  export function planVerifyConsensusHeld<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: Constants.OutpostChainCodename,
    observationNames: readonly string[]
  ): ClusterBuildStep<C, VerifyConsensusHeldInput> {
    return ClusterBuildStep.create<C, VerifyConsensusHeldInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireEconomicClockTool.VerifyConsensusHeldInput",
        chain,
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
      ),
      input.chain
    )
  }

  /**
   * Assert every reading of `observations`, taken in order, shows `chain`'s consensus paused at
   * one index, while the economic epoch index never moved back and ended above where it
   * started — the economic clock kept running while the chain's consensus was held.
   *
   * @param observations - The observations, in the order they were taken.
   * @param chain - The outpost chain whose consensus was held.
   * @throws When the chain's consensus was unpaused or moved, or the economic clock opened no epoch.
   */
  export function assertConsensusHeld(
    observations: readonly Observation[],
    chain: Constants.OutpostChainCodename
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
        reading.consensus[chain].paused,
        `the ${chain} consensus was not paused at economic epoch ${reading.economicEpochIndex}`
      )
      Assert.strictEqual(
        reading.consensus[chain].epochIndex,
        first.consensus[chain].epochIndex,
        `the ${chain} consensus moved from epoch ${first.consensus[chain].epochIndex} while it was held`
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
      `the economic clock opened no epoch while the ${chain} consensus was held at epoch ${first.consensus[chain].epochIndex}`
    )
  }

  // ── Verify: one chain's consensus advanced ────────────────────────────────

  /** Input for {@link planVerifyConsensusAdvanced}. */
  export interface VerifyConsensusAdvancedInput extends StepInput {
    readonly kind: "WireEconomicClockTool.VerifyConsensusAdvancedInput"
    /** The outpost chain whose consensus must have advanced. */
    readonly chain: Constants.OutpostChainCodename
    /** The earlier observation ({@link observationKey}); its latest reading opens the window. */
    readonly fromObservationName: string
    /** The later observation; its latest reading closes the window. */
    readonly toObservationName: string
  }

  /**
   * Assert one chain's consensus ran unpaused and advanced as a depot-paced chain kept due does
   * between two observations ({@link assertConsensusAdvanced}, measured against the chain's
   * `epochcfg` minimum duration) — e.g. while another chain's consensus was held. The window must
   * have kept the chain due (an await with the chain in its `keepDueChains`).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain whose consensus must have advanced.
   * @param fromObservationName - The earlier observation; its latest reading opens the window.
   * @param toObservationName - The later observation; its latest reading closes the window.
   * @returns The verify step.
   */
  export function planVerifyConsensusAdvanced<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: Constants.OutpostChainCodename,
    fromObservationName: string,
    toObservationName: string
  ): ClusterBuildStep<C, VerifyConsensusAdvancedInput> {
    return ClusterBuildStep.create<C, VerifyConsensusAdvancedInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireEconomicClockTool.VerifyConsensusAdvancedInput",
        chain,
        fromObservationName,
        toObservationName
      },
      runVerifyConsensusAdvanced
    )
  }

  /**
   * Named runner — assert the two stored observations' latest readings for the chain, against
   * the chain's `epochcfg` minimum duration.
   *
   * @param ctx - The build context.
   * @param input - The chain and the two observations.
   * @param signal - Abort signal.
   * @throws When an observation was never recorded, the chain has no `epochcfg` row, or the
   *   chain did not advance as a chain kept due does ({@link assertConsensusAdvanced}).
   */
  export async function runVerifyConsensusAdvanced<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyConsensusAdvancedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const advanced = assertConsensusAdvanced(
      latestReading(ctx.outputs.assert(observationKey(input.fromObservationName))),
      latestReading(ctx.outputs.assert(observationKey(input.toObservationName))),
      input.chain,
      await EpochContractSteps.readEpochDurationSec(ctx, input.chain)
    )
    log.info(
      `[economic-clock] the ${input.chain} consensus advanced ${advanced} epoch(s) between ` +
        `"${input.fromObservationName}" and "${input.toObservationName}"`
    )
  }

  // ── Pure: consensus advance ───────────────────────────────────────────────

  /**
   * The fewest consensus epochs of one chain KEPT DUE that must close within a window: a chain
   * given traffic as soon as it is idle closes each epoch within its minimum duration plus the
   * delivery extension ({@link ProtocolTiming.effectiveEpochSec}), so a window of length W holds at
   * least `floor(W / effective)` closes. An idle chain left alone closes none.
   *
   * @param windowMs - The window's length on the chain's clock (ms).
   * @param consensusEpochDurationSec - The chain's minimum consensus epoch duration (s).
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
   * The most consensus epochs of one chain that can close within a window: an advance opens the
   * next epoch at its own time and the chain is due no sooner than one minimum duration later, so
   * two advances are at least the minimum apart and a window of length W holds at most
   * `floor(W / minimum) + 1` closes, however much traffic the chain has.
   *
   * @param windowMs - The window's length on the chain's clock (ms).
   * @param consensusEpochDurationSec - The chain's minimum consensus epoch duration (s).
   * @returns The upper bound on the consensus epochs the window advances.
   */
  export function consensusAdvanceUpperBound(
    windowMs: number,
    consensusEpochDurationSec: number
  ): number {
    return Math.floor(windowMs / (consensusEpochDurationSec * ProtocolTiming.MsPerSecond)) + 1
  }

  /**
   * Assert `chain`'s consensus ran unpaused from `from` to `to`, kept due over the window, and
   * advanced at least {@link consensusAdvanceLowerBound} epochs and at most
   * {@link consensusAdvanceUpperBound} — the chain moved, and never faster than its minimum.
   *
   * @param from - The earlier reading.
   * @param to - The later reading.
   * @param chain - The outpost chain whose consensus is measured.
   * @param consensusEpochDurationSec - The chain's minimum consensus epoch duration (s).
   * @returns The chain's consensus epochs advanced between the readings.
   * @throws When either reading shows the chain paused, the window is shorter than one effective
   *   consensus epoch of the chain (nothing could be measured), or the chain advanced fewer
   *   epochs than the lower bound or more than the upper bound.
   */
  export function assertConsensusAdvanced(
    from: Reading,
    to: Reading,
    chain: Constants.OutpostChainCodename,
    consensusEpochDurationSec: number
  ): number {
    const before = from.consensus[chain],
      after = to.consensus[chain]
    Assert.ok(
      !before.paused && !after.paused,
      `the ${chain} consensus was paused between its epochs ${before.epochIndex} and ${after.epochIndex}`
    )
    const windowMs = to.headBlockTimeMs - from.headBlockTimeMs,
      lowerBound = consensusAdvanceLowerBound(windowMs, consensusEpochDurationSec),
      upperBound = consensusAdvanceUpperBound(windowMs, consensusEpochDurationSec),
      advanced = after.epochIndex - before.epochIndex
    Assert.ok(
      lowerBound >= 1,
      `a ${windowMs} ms window spans no whole ${ProtocolTiming.effectiveEpochSec(consensusEpochDurationSec)} s ${chain} consensus epoch`
    )
    Assert.ok(
      advanced >= lowerBound,
      `the ${chain} consensus advanced ${advanced} epoch(s) in ${windowMs} ms; kept due, its epoch closes within ` +
        `${ProtocolTiming.effectiveEpochSec(consensusEpochDurationSec)} s, so at least ${lowerBound}`
    )
    Assert.ok(
      advanced <= upperBound,
      `the ${chain} consensus advanced ${advanced} epoch(s) in ${windowMs} ms; its minimum of ` +
        `${consensusEpochDurationSec} s allows at most ${upperBound}`
    )
    return advanced
  }
}
