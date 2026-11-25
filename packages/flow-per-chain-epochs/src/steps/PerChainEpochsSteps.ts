import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"

import {
  describeOutpostChains,
  mapOutpostChains,
  OutpostChainCodenames,
  type ClusterConfig,
  type OutpostChainCodename,
  type OutpostEpochDurations,
  type PerOutpostChain
} from "@wireio/cluster-tool-shared"
import {
  ClusterBuildStep,
  ProtocolTiming,
  Steps,
  WireClient,
  WireCollateralTool,
  WireEconomicClockTool,
  isCode,
  matchesProtoEnum,
  outputKey,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type OutputKey,
  type Report,
  type StepInput
} from "@wireio/cluster-tool"

import { PerChainEpochsScenarioConstants as Constants } from "../PerChainEpochsScenarioConstants.js"

const log = getLogger(__filename)

const { SysioContractName, SysioOpregChainServiceStatus } = SysioContracts

/**
 * The per-chain-epochs scenario's Steps: the checks of every outpost chain's depot-paced consensus
 * epoch over recorded clock readings, the awaits that capture a chain's schedule seating an
 * operator or dropping it, the operator's per-chain memberships, the seat-seconds it accrues, and
 * the consensus waits of a withdrawal. A chain advances only once it has traffic, so every await
 * that needs a chain to advance keeps that chain due with keep-due traffic
 * (`EpochAdvanceSteps.pollUntilKeepingDue`): the flow queues nothing to either outpost itself.
 * Every pure check is exported on its own so the scenario's unit tests drive it without a chain.
 */
export namespace PerChainEpochsSteps {
  /** The expected `sysio.opreg::servchains` status per chain; a chain not named has no row. */
  export type ExpectedMemberships = Partial<
    PerOutpostChain<SysioContracts.SysioOpregChainServiceStatus>
  >

  // ── Output keys ───────────────────────────────────────────────────────────

  /**
   * The `ctx.outputs` key a recorded duty period is stored under, one per name.
   *
   * @param periodName - The record's name within the scenario.
   * @returns The typed key.
   */
  export function dutyPeriodKey(periodName: string): OutputKey<number> {
    return outputKey<number>(
      `perChainEpochs.dutyPeriod.${periodName}`,
      `sysio.system::dutystate.open_period recorded as "${periodName}"`
    )
  }

  // ── Budgets ───────────────────────────────────────────────────────────────

  /**
   * A wait of `epochs` effective epochs of one outpost chain kept due (ms), from the cluster's
   * configured minimum duration of that chain — the deadline every per-chain poll of this scenario
   * runs on, and the value its Step ceiling is sized from at plan time.
   *
   * @param config - The resolved cluster config (its `outpostEpochDurationSec`).
   * @param chain - The outpost chain waited on.
   * @param epochs - The chain's epochs waited.
   * @returns The wait (ms).
   */
  export function chainEpochsBudgetMs(
    config: ClusterConfig,
    chain: OutpostChainCodename,
    epochs: number
  ): number {
    return ProtocolTiming.effectiveEpochsMs(config.outpostEpochDurationSec[chain], epochs)
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /**
   * READ each outpost chain's consensus epoch duration from its `epochcfg` row, in one read of the
   * table — the depot's value, which every per-chain check measures against.
   *
   * @param ctx - The build context.
   * @returns Each chain's `epoch_duration_sec`.
   * @throws When a chain has no `epochcfg` row, or the read is truncated.
   */
  export async function readEpochDurations<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<OutpostEpochDurations> {
    const configs = await Steps.contracts.sysio.epoch.readEpochConfigs(ctx)
    return mapOutpostChains(chain => {
      Assert.ok(
        configs[chain] != null,
        `PerChainEpochsSteps: sysio.epoch::epochcfg has no ${chain} row`
      )
      return configs[chain].epoch_duration_sec
    })
  }

  // ── Verify: each chain's configured duration ──────────────────────────────

  /** Input for {@link planVerifyEpochConfiguration}. */
  export interface VerifyEpochConfigurationInput extends StepInput {
    readonly kind: "PerChainEpochsSteps.VerifyEpochConfigurationInput"
    /** Each chain's duration the bootstrap was configured with (the cluster's `outpostEpochDurationSec`). */
    readonly durations: OutpostEpochDurations
  }

  /**
   * Assert each outpost chain's `epochcfg` carries its own configured minimum duration, its
   * `epochstate` paces its next advance by that minimum, and no two chains share a minimum
   * ({@link assertEpochConfiguration}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param durations - Each chain's configured duration.
   * @returns The verify step.
   */
  export function planVerifyEpochConfiguration<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    durations: OutpostEpochDurations
  ): ClusterBuildStep<C, VerifyEpochConfigurationInput> {
    return ClusterBuildStep.create<C, VerifyEpochConfigurationInput>(
      actor,
      name,
      description,
      options,
      { kind: "PerChainEpochsSteps.VerifyEpochConfigurationInput", durations },
      runVerifyEpochConfiguration
    )
  }

  /**
   * Named runner — read every chain's `epochcfg` and consensus reading and assert them.
   *
   * @param ctx - The build context.
   * @param input - The configured durations.
   * @param signal - Abort signal.
   * @throws When a chain has no row, or {@link assertEpochConfiguration} fails.
   */
  export async function runVerifyEpochConfiguration<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyEpochConfigurationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const [depotDurations, consensus] = await Promise.all([
      readEpochDurations(ctx),
      WireEconomicClockTool.readConsensusReadings(ctx)
    ])
    assertEpochConfiguration(depotDurations, consensus, input.durations)
  }

  /**
   * Assert the depot paces each outpost chain by its configured minimum: its `epochcfg` duration
   * is the configured one, its `epochstate` is idle or due exactly one minimum after the later of
   * its epoch start and its traffic ({@link assertDueAt}), and the chains' minimums are pairwise
   * distinct (so each later per-chain check tells the chains apart).
   *
   * @param depotDurations - Each chain's `epochcfg.epoch_duration_sec`.
   * @param consensus - Every chain's consensus epoch, read from its `epochstate` row.
   * @param configured - Each chain's configured duration.
   * @throws On the first chain that differs, or two chains at one duration.
   */
  export function assertEpochConfiguration(
    depotDurations: OutpostEpochDurations,
    consensus: WireEconomicClockTool.ConsensusReadings,
    configured: OutpostEpochDurations
  ): void {
    OutpostChainCodenames.forEach(chain => {
      Assert.strictEqual(
        depotDurations[chain],
        configured[chain],
        `the ${chain} epochcfg runs ${depotDurations[chain]} s epochs, not the configured ${configured[chain]} s`
      )
      assertDueAt(consensus[chain], depotDurations[chain], chain)
    })
    Assert.strictEqual(
      new Set(OutpostChainCodenames.map(chain => configured[chain])).size,
      OutpostChainCodenames.length,
      "two outpost chains run one consensus epoch duration, so no per-chain check can tell them apart"
    )
  }

  /**
   * Assert a chain's `due_at` follows its minimum — pure: an idle chain has neither traffic nor a
   * `due_at`; a chain with traffic is due exactly one minimum after the later of its epoch start
   * and its traffic.
   *
   * @param reading - The chain's consensus reading.
   * @param durationSec - The chain's minimum duration (s).
   * @param chain - The chain (for the message).
   * @throws When an idle chain carries a `due_at` or traffic alone, or a chain with traffic is due
   *   at another time.
   */
  export function assertDueAt(
    reading: WireEconomicClockTool.ConsensusReading,
    durationSec: number,
    chain: OutpostChainCodename
  ): void {
    const { NoTrafficMs } = Steps.contracts.sysio.epoch
    if (reading.trafficSinceMs === NoTrafficMs) {
      Assert.strictEqual(
        reading.dueAtMs,
        NoTrafficMs,
        `the ${chain} epoch ${reading.epochIndex} has no traffic yet is due at ${new Date(reading.dueAtMs).toISOString()}`
      )
      return
    }
    Assert.strictEqual(
      reading.dueAtMs,
      Math.max(reading.epochStartMs, reading.trafficSinceMs) + durationSec * ProtocolTiming.MsPerSecond,
      `the ${chain} epoch ${reading.epochIndex} is not due one ${durationSec} s minimum after the later of its start and its traffic`
    )
  }

  // ── Step: await a wall-clock window on the depot head ─────────────────────

  /** Input for {@link planAwaitWindowElapsed}. */
  export interface AwaitWindowElapsedInput extends StepInput {
    readonly kind: "PerChainEpochsSteps.AwaitWindowElapsedInput"
    /** The clock reading the window starts at (`WireEconomicClockTool.observationKey`). */
    readonly fromObservationName: string
    /** The window's length on the depot head's clock (s). */
    readonly windowSec: number
  }

  /**
   * The poll deadline of {@link planAwaitWindowElapsed} (ms): the window, plus the delivery
   * extension the depot head may trail the wall clock by.
   *
   * @param windowSec - The window (s).
   * @returns The deadline (ms).
   */
  export function windowDeadlineMs(windowSec: number): number {
    return (windowSec + ProtocolTiming.EpochExtensionMaxSec) * ProtocolTiming.MsPerSecond
  }

  /**
   * Wait until the depot head's time is `windowSec` past the named clock reading, keeping every
   * outpost chain due meanwhile — a poll over the chain's own clock, so the window the pacing check
   * measures is the one the chains ran, each given traffic the moment it went idle. Pair it with
   * `ProtocolTiming.pollStepOptions(windowDeadlineMs(windowSec))`.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param fromObservationName - The clock reading the window starts at.
   * @param windowSec - The window's length (s).
   * @returns The await step.
   */
  export function planAwaitWindowElapsed<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    fromObservationName: string,
    windowSec: number
  ): ClusterBuildStep<C, AwaitWindowElapsedInput> {
    return ClusterBuildStep.create<C, AwaitWindowElapsedInput>(
      actor,
      name,
      description,
      options,
      { kind: "PerChainEpochsSteps.AwaitWindowElapsedInput", fromObservationName, windowSec },
      runAwaitWindowElapsed
    )
  }

  /**
   * Named runner — poll the depot head until it is `windowSec` past the starting reading, keeping
   * every chain due (`EpochAdvanceSteps.pollUntilKeepingDue`).
   *
   * @param ctx - The build context.
   * @param input - The starting reading and the window.
   * @param signal - Abort signal.
   * @throws When the reading was never recorded, or the head does not pass the window's end by
   *   {@link windowDeadlineMs}.
   */
  export async function runAwaitWindowElapsed<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitWindowElapsedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const endMs =
      WireEconomicClockTool.latestReading(
        ctx.outputs.assert(WireEconomicClockTool.observationKey(input.fromObservationName))
      ).headBlockTimeMs +
      input.windowSec * ProtocolTiming.MsPerSecond
    await Steps.epochAdvance.pollUntilKeepingDue(
      ctx,
      OutpostChainCodenames,
      `the depot head passes ${new Date(endMs).toISOString()}`,
      async () => WireClient.chainTimeMs((await ctx.wire.getInfo()).head_block_time) >= endMs,
      windowDeadlineMs(input.windowSec),
      Constants.PollIntervalMs,
      signal
    )
  }

  // ── Verify: each chain advanced on its own minimum ──────────────────────

  /** Input for {@link planVerifyOwnMinimum}. */
  export interface VerifyOwnMinimumInput extends StepInput {
    readonly kind: "PerChainEpochsSteps.VerifyOwnMinimumInput"
    /** The clock reading the window starts at (`WireEconomicClockTool.observationKey`). */
    readonly fromObservationName: string
    /** The clock reading the window ends at. */
    readonly toObservationName: string
  }

  /**
   * Assert every chain, kept due over the window between two clock readings, advanced on its own
   * minimum ({@link assertOwnMinimum}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param fromObservationName - The reading the window starts at.
   * @param toObservationName - The reading the window ends at.
   * @returns The verify step.
   */
  export function planVerifyOwnMinimum<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    fromObservationName: string,
    toObservationName: string
  ): ClusterBuildStep<C, VerifyOwnMinimumInput> {
    return ClusterBuildStep.create<C, VerifyOwnMinimumInput>(
      actor,
      name,
      description,
      options,
      { kind: "PerChainEpochsSteps.VerifyOwnMinimumInput", fromObservationName, toObservationName },
      runVerifyOwnMinimum
    )
  }

  /**
   * Named runner — read every chain's minimum and assert the two stored readings.
   *
   * @param ctx - The build context.
   * @param input - The two readings.
   * @param signal - Abort signal.
   * @throws When a reading was never recorded, a chain has no `epochcfg` row, or
   *   {@link assertOwnMinimum} fails.
   */
  export async function runVerifyOwnMinimum<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyOwnMinimumInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const advanced = assertOwnMinimum(
      WireEconomicClockTool.latestReading(
        ctx.outputs.assert(WireEconomicClockTool.observationKey(input.fromObservationName))
      ),
      WireEconomicClockTool.latestReading(
        ctx.outputs.assert(WireEconomicClockTool.observationKey(input.toObservationName))
      ),
      await readEpochDurations(ctx)
    )
    log.info(`[per-chain-epochs] epochs advanced over the window: ${describeOutpostChains(advanced)}`)
  }

  /**
   * Assert each outpost chain, kept due between two readings, advanced on its own minimum: each
   * ran unpaused and closed at least as many epochs as a chain kept due closes and no more than
   * its minimum allows (`WireEconomicClockTool.assertConsensusAdvanced`), the epochs between the
   * readings started at least one minimum of the chain apart (an advance opens the next epoch at
   * its own time, never on a grid: `start(to) - start(from) >= (to - from) × minimum`), and a chain
   * with a shorter minimum advanced more than every chain with a longer one.
   *
   * @param from - The earlier reading.
   * @param to - The later reading.
   * @param durations - Each chain's minimum duration (s).
   * @returns The epochs each chain advanced.
   * @throws On the first chain paused, outside its advance bounds or started closer than its
   *   minimum, or when a faster chain did not out-advance a slower one.
   */
  export function assertOwnMinimum(
    from: WireEconomicClockTool.Reading,
    to: WireEconomicClockTool.Reading,
    durations: OutpostEpochDurations
  ): PerOutpostChain<number> {
    const advanced = mapOutpostChains(chain => {
      const before = from.consensus[chain],
        after = to.consensus[chain],
        count = WireEconomicClockTool.assertConsensusAdvanced(from, to, chain, durations[chain])
      Assert.ok(
        after.epochStartMs - before.epochStartMs >= count * durations[chain] * ProtocolTiming.MsPerSecond,
        `the ${chain} epochs ${before.epochIndex}..${after.epochIndex} started less than ${durations[chain]} s apart`
      )
      return count
    })
    OutpostChainCodenames.forEach(faster =>
      OutpostChainCodenames.filter(slower => durations[slower] > durations[faster]).forEach(slower =>
        Assert.ok(
          advanced[faster] > advanced[slower],
          `the ${durations[faster]} s ${faster} epoch advanced ${advanced[faster]} time(s), ` +
            `no more than the ${durations[slower]} s ${slower} epoch's ${advanced[slower]}`
        )
      )
    )
    return advanced
  }

  // ── Step: await a chain's consensus advancing ─────────────────────────────

  /** Input for {@link planAwaitConsensusAdvanced}. */
  export interface AwaitConsensusAdvancedInput extends StepInput {
    readonly kind: "PerChainEpochsSteps.AwaitConsensusAdvancedInput"
    /** The outpost chain waited on. */
    readonly chain: OutpostChainCodename
    /** The epochs it must advance past its index when the Step starts. */
    readonly count: number
    /** Effective epochs of the chain the poll allows ({@link chainEpochsBudgetMs}). */
    readonly budgetEpochs: number
  }

  /**
   * Wait for one chain's consensus epoch to advance `count` epochs from where it is when the
   * Step starts, keeping the chain due.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain waited on.
   * @param count - The epochs it must advance.
   * @param budgetEpochs - Effective epochs of the chain the poll allows.
   * @returns The await step.
   */
  export function planAwaitConsensusAdvanced<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: OutpostChainCodename,
    count: number,
    budgetEpochs: number
  ): ClusterBuildStep<C, AwaitConsensusAdvancedInput> {
    return ClusterBuildStep.create<C, AwaitConsensusAdvancedInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "PerChainEpochsSteps.AwaitConsensusAdvancedInput",
        chain,
        count,
        budgetEpochs
      },
      runAwaitConsensusAdvanced
    )
  }

  /**
   * Named runner — poll the chain's `current_epoch_index` until it moved `count` epochs, keeping
   * the chain due (`EpochAdvanceSteps.pollUntilKeepingDue`).
   *
   * @param ctx - The build context.
   * @param input - The chain, the count and the budget.
   * @param signal - Abort signal.
   * @throws When the chain has not advanced `count` epochs within the budget.
   */
  export async function runAwaitConsensusAdvanced<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitConsensusAdvancedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const start = await Steps.contracts.sysio.epoch.readCurrentEpochIndex(ctx, input.chain)
    await Steps.epochAdvance.pollUntilKeepingDue(
      ctx,
      [input.chain],
      `the ${input.chain} consensus advances ${input.count} epoch(s) past ${start}`,
      async () =>
        (await Steps.contracts.sysio.epoch.readCurrentEpochIndex(ctx, input.chain)) >=
        start + input.count,
      chainEpochsBudgetMs(ctx.config, input.chain, input.budgetEpochs),
      Constants.PollIntervalMs,
      signal
    )
  }

  // ── Verify: the operator's chain memberships ──────────────────────────────

  /** Input for {@link planVerifyMemberships}. */
  export interface VerifyMembershipsInput extends StepInput {
    readonly kind: "PerChainEpochsSteps.VerifyMembershipsInput"
    /** The operator's durable label. */
    readonly label: string
    /** The status each named chain's row must carry; a chain not named must have no row. */
    readonly expected: ExpectedMemberships
  }

  /**
   * Assert the operator's `sysio.opreg::servchains` rows are exactly `expected`
   * ({@link assertMemberships}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param label - The operator's durable label.
   * @param expected - The status per named chain.
   * @returns The verify step.
   */
  export function planVerifyMemberships<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    expected: ExpectedMemberships
  ): ClusterBuildStep<C, VerifyMembershipsInput> {
    return ClusterBuildStep.create<C, VerifyMembershipsInput>(
      actor,
      name,
      description,
      options,
      { kind: "PerChainEpochsSteps.VerifyMembershipsInput", label, expected },
      runVerifyMemberships
    )
  }

  /**
   * Named runner — read every membership row and assert the operator's.
   *
   * @param ctx - The build context.
   * @param input - The operator and its expected memberships.
   * @param signal - Abort signal.
   * @throws When the operator is not in the key store, or {@link assertMemberships} fails.
   */
  export async function runVerifyMemberships<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyMembershipsInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertMemberships(
      await Steps.contracts.sysio.opreg.readServedChains(ctx),
      ctx.keyStore.assertOperator(input.label).account,
      input.expected
    )
  }

  /**
   * Assert `account`'s memberships: each chain named in `expected` has a row with that status
   * (compared by the ABI enum) and, being neither evicted nor otherwise explained, an empty
   * `status_reason`; each chain not named has no row.
   *
   * @param rows - Every `sysio.opreg::servchains` row.
   * @param account - The operator's account.
   * @param expected - The status per named chain.
   * @throws On the first chain whose row differs.
   */
  export function assertMemberships(
    rows: readonly SysioContracts.SysioOpregServedChainType[],
    account: string,
    expected: ExpectedMemberships
  ): void {
    OutpostChainCodenames.forEach(chain => {
      const row = rows.find(candidate =>
          Steps.contracts.sysio.opreg.isMembershipRow(candidate, account, chain)
        ),
        status = expected[chain]
      if (status == null) {
        Assert.ok(row == null, `${account} has a ${chain} membership (${row?.status}); it never joined the chain`)
        return
      }
      Assert.ok(row != null, `${account} has no ${chain} membership`)
      Assert.ok(
        matchesProtoEnum(row.status, SysioOpregChainServiceStatus, status),
        `${account}'s ${chain} membership is ${row.status}, not ${SysioOpregChainServiceStatus[status]}`
      )
      Assert.strictEqual(
        row.status_reason,
        "",
        `${account}'s ${chain} membership carries a status reason (${row.status_reason}) it was never evicted for`
      )
    })
  }

  // ── Steps: a chain's schedule seating the operator, or not ────────────────

  /** Input for the seating awaits and verifies. */
  export interface SeatingInput extends StepInput {
    readonly kind: "PerChainEpochsSteps.SeatingInput"
    /** The operator's durable label. */
    readonly label: string
    /** The outpost chain whose schedule window is read. */
    readonly chain: OutpostChainCodename
    /** Effective epochs of the chain the poll allows (0 for a single read). */
    readonly budgetEpochs: number
  }

  /** The {@link SeatingInput} of one operator on one chain. */
  function createSeatingInput(
    label: string,
    chain: OutpostChainCodename,
    budgetEpochs: number
  ): SeatingInput {
    return { kind: "PerChainEpochsSteps.SeatingInput", label, chain, budgetEpochs }
  }

  /** The operator's seat state on the input's chain (a read of its `epochstate` row). */
  async function readSeated<C extends ClusterBuildContext>(ctx: C, input: SeatingInput): Promise<boolean> {
    return Steps.contracts.sysio.epoch.isSeated(
      await Steps.contracts.sysio.epoch.readEpochState(ctx, input.chain),
      ctx.keyStore.assertOperator(input.label).account
    )
  }

  /**
   * Wait until a group of the chain's schedule window seats the operator.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param label - The operator's durable label.
   * @param chain - The outpost chain whose window is read.
   * @param budgetEpochs - Effective epochs of the chain the poll allows.
   * @returns The await step.
   */
  export function planAwaitOperatorSeated<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    chain: OutpostChainCodename,
    budgetEpochs: number
  ): ClusterBuildStep<C, SeatingInput> {
    return ClusterBuildStep.create<C, SeatingInput>(
      actor,
      name,
      description,
      options,
      createSeatingInput(label, chain, budgetEpochs),
      runAwaitOperatorSeated
    )
  }

  /**
   * Named runner — poll the chain's window until it seats the operator.
   *
   * @param ctx - The build context.
   * @param input - The operator, the chain and the budget.
   * @param signal - Abort signal.
   * @throws When no group seats the operator within the budget.
   */
  export async function runAwaitOperatorSeated<C extends ClusterBuildContext>(
    ctx: C,
    input: SeatingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await Steps.epochAdvance.pollUntilKeepingDue(
      ctx,
      [input.chain],
      `the ${input.chain} schedule window seats ${input.label}`,
      async () => readSeated(ctx, input),
      chainEpochsBudgetMs(ctx.config, input.chain, input.budgetEpochs),
      Constants.PollIntervalMs,
      signal
    )
  }

  /**
   * Wait until no group of the chain's schedule window seats the operator: its seats there closed.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param label - The operator's durable label.
   * @param chain - The outpost chain whose window is read.
   * @param budgetEpochs - Effective epochs of the chain the poll allows.
   * @returns The await step.
   */
  export function planAwaitOperatorUnseated<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    chain: OutpostChainCodename,
    budgetEpochs: number
  ): ClusterBuildStep<C, SeatingInput> {
    return ClusterBuildStep.create<C, SeatingInput>(
      actor,
      name,
      description,
      options,
      createSeatingInput(label, chain, budgetEpochs),
      runAwaitOperatorUnseated
    )
  }

  /**
   * Named runner — poll the chain's window until it no longer seats the operator.
   *
   * @param ctx - The build context.
   * @param input - The operator, the chain and the budget.
   * @param signal - Abort signal.
   * @throws When a group still seats the operator at the end of the budget.
   */
  export async function runAwaitOperatorUnseated<C extends ClusterBuildContext>(
    ctx: C,
    input: SeatingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await Steps.epochAdvance.pollUntilKeepingDue(
      ctx,
      [input.chain],
      `the ${input.chain} schedule window no longer seats ${input.label}`,
      async () => !(await readSeated(ctx, input)),
      chainEpochsBudgetMs(ctx.config, input.chain, input.budgetEpochs),
      Constants.PollIntervalMs,
      signal
    )
  }

  /**
   * Assert no group of the chain's schedule window seats the operator now.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param label - The operator's durable label.
   * @param chain - The outpost chain whose window is read.
   * @returns The verify step.
   */
  export function planVerifyOperatorUnseated<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    chain: OutpostChainCodename
  ): ClusterBuildStep<C, SeatingInput> {
    return ClusterBuildStep.create<C, SeatingInput>(
      actor,
      name,
      description,
      options,
      createSeatingInput(label, chain, 0),
      runVerifyOperatorUnseated
    )
  }

  /**
   * Named runner — one read of the chain's window.
   *
   * @param ctx - The build context.
   * @param input - The operator and the chain.
   * @param signal - Abort signal.
   * @throws When a group of the window seats the operator.
   */
  export async function runVerifyOperatorUnseated<C extends ClusterBuildContext>(
    ctx: C,
    input: SeatingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    Assert.ok(
      !(await readSeated(ctx, input)),
      `the ${input.chain} schedule window seats ${input.label}, which does not serve the chain`
    )
  }

  /**
   * Assert the chain's schedule window seats the operator in no group while the chain advances
   * `budgetEpochs` epochs — through a full rotation every new tail group leaves it out.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param label - The operator's durable label.
   * @param chain - The outpost chain whose window is read.
   * @param budgetEpochs - The chain's epochs to watch; also the poll's budget.
   * @returns The verify step.
   */
  export function planVerifyUnseatedForRotation<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    chain: OutpostChainCodename,
    budgetEpochs: number
  ): ClusterBuildStep<C, SeatingInput> {
    return ClusterBuildStep.create<C, SeatingInput>(
      actor,
      name,
      description,
      options,
      createSeatingInput(label, chain, budgetEpochs),
      runVerifyUnseatedForRotation
    )
  }

  /**
   * Named runner — read the window on every poll until the chain moved `budgetEpochs` epochs;
   * fail the moment it seats the operator.
   *
   * @param ctx - The build context.
   * @param input - The operator, the chain and the epochs to watch.
   * @param signal - Abort signal.
   * @throws When a group seats the operator again, or the chain does not advance in time.
   */
  export async function runVerifyUnseatedForRotation<C extends ClusterBuildContext>(
    ctx: C,
    input: SeatingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const start = await Steps.contracts.sysio.epoch.readCurrentEpochIndex(ctx, input.chain)
    await Steps.epochAdvance.pollUntilKeepingDue(
      ctx,
      [input.chain],
      `the ${input.chain} consensus advances ${input.budgetEpochs} epoch(s) past ${start} with ${input.label} unseated`,
      async () => {
        Assert.ok(
          !(await readSeated(ctx, input)),
          `the ${input.chain} schedule window seated ${input.label} again after it left the chain`
        )
        return (
          (await Steps.contracts.sysio.epoch.readCurrentEpochIndex(ctx, input.chain)) >=
          start + input.budgetEpochs
        )
      },
      chainEpochsBudgetMs(ctx.config, input.chain, input.budgetEpochs),
      Constants.PollIntervalMs,
      signal
    )
  }

  /** Input for {@link planAwaitOperatorReseated}. */
  export interface AwaitOperatorReseatedInput extends StepInput {
    readonly kind: "PerChainEpochsSteps.AwaitOperatorReseatedInput"
    /** The operator's durable label. */
    readonly label: string
    /** The outpost chain whose window is read. */
    readonly chain: OutpostChainCodename
    /** The epoch-index snapshot the new seat must postdate (`EpochAdvanceSteps.epochIndicesKey`). */
    readonly sinceSnapshotName: string
    /** Effective epochs of the chain the poll allows. */
    readonly budgetEpochs: number
  }

  /**
   * Wait until the chain's window seats the operator in a group appended after the named
   * snapshot: one serving an epoch at least the window's length past the snapshot's index, which
   * no group resident at the snapshot serves ({@link newSeatEpoch}).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param label - The operator's durable label.
   * @param chain - The outpost chain whose window is read.
   * @param sinceSnapshotName - The epoch-index snapshot the new seat must postdate.
   * @param budgetEpochs - Effective epochs of the chain the poll allows.
   * @returns The await step.
   */
  export function planAwaitOperatorReseated<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    chain: OutpostChainCodename,
    sinceSnapshotName: string,
    budgetEpochs: number
  ): ClusterBuildStep<C, AwaitOperatorReseatedInput> {
    return ClusterBuildStep.create<C, AwaitOperatorReseatedInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "PerChainEpochsSteps.AwaitOperatorReseatedInput",
        label,
        chain,
        sinceSnapshotName,
        budgetEpochs
      },
      runAwaitOperatorReseated
    )
  }

  /**
   * Named runner — poll the chain's `epochstate` until a group appended after the snapshot seats
   * the operator.
   *
   * @param ctx - The build context.
   * @param input - The operator, the chain, the snapshot and the budget.
   * @param signal - Abort signal.
   * @throws When the snapshot was never recorded, or no such group seats the operator in time.
   */
  export async function runAwaitOperatorReseated<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitOperatorReseatedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const since = ctx.outputs.assert(Steps.epochAdvance.epochIndicesKey(input.sinceSnapshotName))[
        input.chain
      ],
      account = ctx.keyStore.assertOperator(input.label).account,
      epoch = await Steps.epochAdvance.pollForKeepingDue(
        ctx,
        [input.chain],
        `a ${input.chain} group appended after epoch ${since} seats ${input.label}`,
        async () => newSeatEpoch(await Steps.contracts.sysio.epoch.readEpochState(ctx, input.chain), account, since),
        chainEpochsBudgetMs(ctx.config, input.chain, input.budgetEpochs),
        Constants.PollIntervalMs,
        signal
      )
    log.info(`[per-chain-epochs] ${input.chain} seats ${input.label} again for its epoch ${epoch}`)
  }

  /**
   * The epoch a group appended after epoch `since` seats `account` for, or `undefined` when no such
   * group does — pure. Window slot `k` serves epoch `current_epoch_index + k - current_batch_op_group`;
   * at epoch `since` the resident groups served `since .. since + groups - 1`, so a slot serving
   * `since + groups` or later was appended afterwards.
   *
   * @param state - The chain's `epochstate` row (absent when the chain has no schedule).
   * @param account - The operator's account.
   * @param since - The chain's epoch index at the snapshot.
   * @returns The epoch the new seat serves, when there is one.
   */
  export function newSeatEpoch(
    state: SysioContracts.SysioEpochEpochStateType,
    account: string,
    since: number
  ): number {
    const groups = state?.batch_op_groups ?? []
    return groups
      .map((group, slot) => ({
        group,
        epoch: state.current_epoch_index + slot - state.current_batch_op_group
      }))
      .find(({ group, epoch }) => group.includes(account) && epoch >= since + groups.length)?.epoch
  }

  // ── Steps: seat-seconds ───────────────────────────────────────────────────

  /**
   * READ the `sysio.system::dutystate` row — the open pay period whose `batchduty` rows accrue.
   *
   * @param ctx - The build context.
   * @returns The row (absent before `initt5` has run).
   */
  export async function readDutyState<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioSystemDutyStateType> {
    const { rows } = await ctx.wire.getSysioContract(SysioContractName.system).tables.dutystate.query()
    return rows[0]
  }

  /**
   * READ every `sysio.system::batchduty` row, from one complete read.
   *
   * @param ctx - The build context.
   * @returns Every row: each operator's seat-seconds per pay period.
   * @throws When the table holds more than `PerChainEpochsScenarioConstants.DutyRowLimit` rows.
   */
  export async function readBatchDuty<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioSystemBatchDutyType[]> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.system)
      .tables.batchduty.query({ limit: Constants.DutyRowLimit })
    Assert.ok(!more, `sysio.system::batchduty has more than ${Constants.DutyRowLimit} rows; the read is truncated`)
    return rows
  }

  /** Input for {@link planRecordDutyPeriod}. */
  export interface RecordDutyPeriodInput extends StepInput {
    readonly kind: "PerChainEpochsSteps.RecordDutyPeriodInput"
    /** The name the period is stored under ({@link dutyPeriodKey}). */
    readonly periodName: string
  }

  /**
   * Record `sysio.system::dutystate.open_period` now, so a later Step can wait for a period
   * after it — a read, carried by a Step because that later Step compares against it.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param periodName - The name the period is stored under.
   * @returns The record step.
   */
  export function planRecordDutyPeriod<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    periodName: string
  ): ClusterBuildStep<C, RecordDutyPeriodInput> {
    return ClusterBuildStep.create<C, RecordDutyPeriodInput>(
      actor,
      name,
      description,
      options,
      { kind: "PerChainEpochsSteps.RecordDutyPeriodInput", periodName },
      runRecordDutyPeriod
    )
  }

  /**
   * Named runner — read `dutystate` and store its open period.
   *
   * @param ctx - The build context.
   * @param input - The period's name.
   * @param signal - Abort signal.
   * @throws When `dutystate` has no row.
   */
  export async function runRecordDutyPeriod<C extends ClusterBuildContext>(
    ctx: C,
    input: RecordDutyPeriodInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const state = await readDutyState(ctx)
    Assert.ok(state != null, "sysio.system::dutystate has no row — initt5 has not run")
    ctx.outputs.set(dutyPeriodKey(input.periodName), state.open_period)
  }

  /**
   * The deadline of a seat-second await (ms): `budgetEpochs` effective epochs of the chain the
   * operator is seated on, for its next seat to close, the advance that closes that seat's books
   * (`PerChainEpochsScenarioConstants.BookClosingEpochs` more epochs of the chain), then the open pay
   * period's close (`PerChainEpochsScenarioConstants.DutyPeriodEconomicEpochs` economic epochs).
   *
   * @param config - The resolved cluster config.
   * @param chain - The chain the operator is seated on.
   * @param budgetEpochs - The chain's epochs allowed for its seat to close.
   * @returns The deadline (ms).
   */
  export function seatSecondsDeadlineMs(
    config: ClusterConfig,
    chain: OutpostChainCodename,
    budgetEpochs: number
  ): number {
    return (
      chainEpochsBudgetMs(config, chain, budgetEpochs + Constants.BookClosingEpochs) +
      ProtocolTiming.effectiveEpochsMs(config.economicEpochDurationSec, Constants.DutyPeriodEconomicEpochs)
    )
  }

  /** Input for {@link planAwaitSeatSecondsAccrued}. */
  export interface AwaitSeatSecondsAccruedInput extends StepInput {
    readonly kind: "PerChainEpochsSteps.AwaitSeatSecondsAccruedInput"
    /** The operator's durable label. */
    readonly label: string
    /** The one outpost chain the operator holds seats on in the awaited period. */
    readonly chain: OutpostChainCodename
    /** The chain's epochs allowed for the operator's seat to close ({@link seatSecondsDeadlineMs}). */
    readonly budgetEpochs: number
    /** The recorded period the accrual must come after ({@link dutyPeriodKey}); any period when omitted. */
    readonly sincePeriodName?: string
  }

  /**
   * Wait for the operator's `sysio.system::batchduty` row on `chain` (rows are keyed by operator and
   * chain) of a pay period (after the named one, when given) to hold seat-seconds, and assert they
   * are a whole number of the chain's epoch durations ({@link assertSeatSeconds}) and that no other
   * chain's row of the operator holds seat-seconds in that period ({@link assertNoOtherChainDuty}) —
   * every seat it held in the period was on that chain.
   * Pair it with `ProtocolTiming.pollStepOptions(seatSecondsDeadlineMs(config, chain, budgetEpochs))`.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param label - The operator's durable label.
   * @param chain - The one chain the operator holds seats on.
   * @param budgetEpochs - The chain's epochs allowed for its seat to close.
   * @param sincePeriodName - The recorded period the accrual must come after; any when omitted.
   * @returns The await step.
   */
  export function planAwaitSeatSecondsAccrued<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    chain: OutpostChainCodename,
    budgetEpochs: number,
    sincePeriodName?: string
  ): ClusterBuildStep<C, AwaitSeatSecondsAccruedInput> {
    return ClusterBuildStep.create<C, AwaitSeatSecondsAccruedInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "PerChainEpochsSteps.AwaitSeatSecondsAccruedInput",
        label,
        chain,
        budgetEpochs,
        sincePeriodName
      },
      runAwaitSeatSecondsAccrued
    )
  }

  /**
   * Named runner — poll `batchduty` for the operator's accruing row on the chain, then assert its
   * seat-seconds and, from the same read, that no other chain's row of the operator accrued in its
   * period.
   *
   * @param ctx - The build context.
   * @param input - The operator, the chain, the budget and the period to come after.
   * @param signal - Abort signal.
   * @throws When the period was never recorded, the chain has no `epochcfg` row, no row accrues in
   *   time, or {@link assertSeatSeconds} or {@link assertNoOtherChainDuty} fails.
   */
  export async function runAwaitSeatSecondsAccrued<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitSeatSecondsAccruedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const account = ctx.keyStore.assertOperator(input.label).account,
      sincePeriod =
        input.sincePeriodName == null ? 0 : ctx.outputs.assert(dutyPeriodKey(input.sincePeriodName)),
      durationSec = await Steps.contracts.sysio.epoch.readEpochDurationSec(ctx, input.chain),
      accrues = (candidate: SysioContracts.SysioSystemBatchDutyType): boolean =>
        isSeatSecondsAccrual(candidate, account, input.chain, sincePeriod),
      rows = await Steps.epochAdvance.pollForKeepingDue(
        ctx,
        [input.chain],
        `${input.label} accrues ${input.chain} seat-seconds in a pay period after ${sincePeriod}`,
        async () => {
          const read = await readBatchDuty(ctx)
          return read.some(accrues) ? read : null
        },
        seatSecondsDeadlineMs(ctx.config, input.chain, input.budgetEpochs),
        Constants.PollIntervalMs,
        signal
      ),
      row = rows.find(accrues),
      seats = assertSeatSeconds(BigInt(row.seat_seconds), durationSec, input.chain)
    assertNoOtherChainDuty(rows, row, input.chain)
    log.info(
      `[per-chain-epochs] ${input.label} holds ${row.seat_seconds} seat-seconds in pay period ${row.period}: ` +
        `${seats} ${input.chain} seat(s) of ${durationSec} s`
    )
  }

  /**
   * Whether a `batchduty` row is the operator's accrual on `chain` in a pay period after
   * `sincePeriod` — pure.
   *
   * @param row - One `batchduty` row.
   * @param account - The operator's on-chain account.
   * @param chain - The chain the row must be of.
   * @param sincePeriod - The pay period the row must come after.
   * @returns True when the row is the operator's on `chain`, of a later period, with seat-seconds.
   */
  export function isSeatSecondsAccrual(
    row: SysioContracts.SysioSystemBatchDutyType,
    account: string,
    chain: OutpostChainCodename,
    sincePeriod: number
  ): boolean {
    return (
      row.account_name === account &&
      isCode(row.chain_code, chain) &&
      row.period > sincePeriod &&
      BigInt(row.seat_seconds) > 0n
    )
  }

  /**
   * Assert the operator accrued seat-seconds on no chain but `chain` in the pay period of its
   * `chain` row — pure. A row holds one chain's seats only, so a seat on another chain shows in
   * that chain's row of the same period, never in this one.
   *
   * @param rows - One complete `batchduty` read.
   * @param row - The operator's row on `chain`.
   * @param chain - The one chain the operator held seats on in the period.
   * @throws When another chain's row of the operator in the same period holds seat-seconds.
   */
  export function assertNoOtherChainDuty(
    rows: SysioContracts.SysioSystemBatchDutyType[],
    row: SysioContracts.SysioSystemBatchDutyType,
    chain: OutpostChainCodename
  ): void {
    const others = rows
      .filter(
        candidate =>
          candidate.account_name === row.account_name &&
          candidate.period === row.period &&
          !isCode(candidate.chain_code, chain) &&
          BigInt(candidate.seat_seconds) > 0n
      )
      .map(candidate => candidate.chain_code)
    Assert.deepStrictEqual(
      others,
      [],
      `${row.account_name} also accrued seat-seconds on ${others.join(", ")} in pay period ${row.period}, not only on ${chain}`
    )
  }

  /**
   * Assert a seat-second total is exactly a positive number of seats times one chain's minimum
   * duration — pure. Each duty epoch credits the chain's minimum to each seated operator's row of
   * that chain (`sysio.system::rcrdduty`), however long the epoch ran, so the row accrues exactly
   * seats × minimum.
   *
   * @param seatSeconds - The `batchduty.seat_seconds`.
   * @param durationSec - The chain's minimum duration (s).
   * @param chain - The chain (for the message).
   * @returns The seats the total stands for.
   * @throws When the total is zero or not a whole multiple of the duration.
   */
  export function assertSeatSeconds(
    seatSeconds: bigint,
    durationSec: number,
    chain: OutpostChainCodename
  ): number {
    const duration = BigInt(durationSec)
    Assert.ok(seatSeconds > 0n, `no ${chain} seat-seconds accrued`)
    Assert.strictEqual(
      seatSeconds % duration,
      0n,
      `${seatSeconds} seat-seconds are not a whole number of ${durationSec} s ${chain} seats`
    )
    return Number(seatSeconds / duration)
  }

  // ── Verify: a withdrawal's consensus waits ────────────────────────────────

  /** Input for {@link planVerifyWithdrawalWaits}. */
  export interface VerifyWithdrawalWaitsInput extends StepInput {
    readonly kind: "PerChainEpochsSteps.VerifyWithdrawalWaitsInput"
    /** The withdrawing operator's durable label. */
    readonly label: string
    /** The one outpost chain the request must wait on. */
    readonly chain: OutpostChainCodename
    /** The epoch-index snapshot taken right before the request (`EpochAdvanceSteps.epochIndicesKey`). */
    readonly beforeSnapshotName: string
  }

  /**
   * Assert the operator's newest queued withdrawal waits on `chain`'s consensus alone,
   * `WireCollateralTool.WithdrawWaitConsensusEpochs` of its epochs past the request
   * (`WireCollateralTool.assertConsensusWaits`).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param label - The withdrawing operator's durable label.
   * @param chain - The one chain the request must wait on.
   * @param beforeSnapshotName - The epoch-index snapshot taken right before the request.
   * @returns The verify step.
   */
  export function planVerifyWithdrawalWaits<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    chain: OutpostChainCodename,
    beforeSnapshotName: string
  ): ClusterBuildStep<C, VerifyWithdrawalWaitsInput> {
    return ClusterBuildStep.create<C, VerifyWithdrawalWaitsInput>(
      actor,
      name,
      description,
      options,
      { kind: "PerChainEpochsSteps.VerifyWithdrawalWaitsInput", label, chain, beforeSnapshotName },
      runVerifyWithdrawalWaits
    )
  }

  /**
   * Named runner — read the operator's queue rows and every chain's index now, then assert the
   * newest request against the snapshot taken before it.
   *
   * @param ctx - The build context.
   * @param input - The operator, the chain and the snapshot.
   * @param signal - Abort signal.
   * @throws When the operator has no queued withdrawal, the snapshot was never recorded, or the
   *   request's consensus waits are not the one chain's guard.
   */
  export async function runVerifyWithdrawalWaits<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyWithdrawalWaitsInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const account = ctx.keyStore.assertOperator(input.label).account,
      requests = await WireCollateralTool.readWithdrawRequests(ctx, account)
    Assert.ok(requests.length > 0, `${input.label} has no queued withdrawal`)
    const newest = requests.reduce((latest, request) =>
      BigInt(request.request_id) > BigInt(latest.request_id) ? request : latest
    )
    WireCollateralTool.assertConsensusWaits(
      newest,
      [input.chain],
      ctx.outputs.assert(Steps.epochAdvance.epochIndicesKey(input.beforeSnapshotName)),
      await Steps.contracts.sysio.epoch.readCurrentEpochIndices(ctx)
    )
  }
}
