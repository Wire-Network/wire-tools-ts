import Assert from "node:assert"

import {
  describeOutpostChains,
  OutpostChainCodenames,
  type ClusterConfig,
  type PerOutpostChain
} from "@wireio/cluster-tool-shared"

import { type Constants, ProtocolTiming } from "../../Constants.js"
import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { outputKey, type OutputKey } from "../OutputStore.js"
import type { StepInput } from "../StepRunner.js"
import { pollUntil } from "../StepTools.js"
import { EpochContractSteps } from "./contracts/sysio/EpochContractSteps.js"

const log = getLogger(__filename)

/**
 * Steps that wait on every outpost chain's consensus epoch advancing, each on its own cadence:
 * the bootstrap's per-chain gate ({@link EpochAdvanceSteps.planAwaitEpochAdvanced}), and a
 * snapshot of every chain's epoch index ({@link EpochAdvanceSteps.planRecordEpochIndices})
 * that a later Step verifies each chain advanced past
 * ({@link EpochAdvanceSteps.planVerifyEpochIndicesAdvanced}). Every wait polls the chains'
 * `sysio.epoch::epochstate` rows, returns the moment its condition holds, and logs and retries
 * a read that fails transiently. `ClusterManager.run`'s relaunch liveness gate is
 * {@link EpochAdvanceSteps.awaitEpochIndicesAdvanced}, the same poll.
 */
export namespace EpochAdvanceSteps {
  /**
   * The epoch index the bootstrap gate waits for on each chain. `sysio.msgch::bootstrap` takes
   * every chain 0 → 1 inline, so 2 is the first index only `sysio.epoch::advance(chain)` firing
   * on the chain's own cadence can produce — OPP circulating on that outpost, not merely
   * bootstrapped.
   */
  export const BootstrapAdvanceTargetIndex = 2

  /**
   * The epoch-advance budget of one outpost chain (ms) — {@link ProtocolTiming.epochAdvanceBudgetMs}
   * of the chain's duration: {@link ProtocolTiming.EpochVerifyEpochCount} effective epochs,
   * never less than the OPP circulation (re)start.
   *
   * @param config - The resolved cluster config (its `outpostEpochDurationSec`).
   * @param chain - The outpost chain whose epoch is awaited.
   * @returns The budget (ms).
   */
  export function epochAdvanceBudgetMs(
    config: ClusterConfig,
    chain: Constants.OutpostChainCodename
  ): number {
    return ProtocolTiming.epochAdvanceBudgetMs(config.outpostEpochDurationSec[chain])
  }

  /**
   * The budget of a wait on EVERY outpost chain's epoch advancing (ms) —
   * {@link ProtocolTiming.epochAdvanceBudgetMs} of the slowest chain's duration, since the
   * wait ends only once that chain has advanced too.
   *
   * @param config - The resolved cluster config (its `outpostEpochDurationSec`).
   * @returns The budget (ms).
   */
  export function everyChainAdvanceBudgetMs(config: ClusterConfig): number {
    return ProtocolTiming.epochAdvanceBudgetMs(
      ProtocolTiming.slowestOutpostEpochSec(config.outpostEpochDurationSec)
    )
  }

  /**
   * Poll every outpost chain's consensus epoch index until `isDone` holds of it. A read that
   * throws is logged at debug and polled again: the gate tolerates a transient RPC failure and
   * fails only on the deadline, with `label` in the message.
   *
   * @param ctx - The build context.
   * @param label - What the poll waits for, named in its timeout message.
   * @param isDone - Whether the chains' indices satisfy the wait.
   * @param budgetMs - The poll's deadline (ms).
   * @throws When the deadline passes before `isDone` holds.
   */
  async function pollEpochIndices<C extends ClusterBuildContext>(
    ctx: C,
    label: string,
    isDone: (indices: PerOutpostChain<number>) => boolean,
    budgetMs: number
  ): Promise<void> {
    await pollUntil(
      label,
      async () => {
        try {
          return isDone(await EpochContractSteps.readCurrentEpochIndices(ctx))
        } catch (error) {
          log.debug(
            `[epoch-advance] epoch-state read transient: ${error instanceof Error ? error.message : String(error)}`
          )
          return false
        }
      },
      budgetMs,
      ProtocolTiming.EpochVerifyPollIntervalMs
    )
  }

  // ── Step: one chain's epoch reaches the bootstrap target ─────────────────

  /** Input for {@link planAwaitEpochAdvanced}. */
  export interface AwaitEpochAdvancedInput extends StepInput {
    readonly kind: "EpochAdvanceSteps.AwaitEpochAdvancedInput"
    /** The outpost chain whose epoch the gate watches. */
    readonly chain: Constants.OutpostChainCodename
  }

  /**
   * The bootstrap success gate of one outpost chain: wait for its epoch to reach
   * {@link BootstrapAdvanceTargetIndex} ({@link runAwaitEpochAdvanced}). The poll owns the
   * whole {@link epochAdvanceBudgetMs} (no Step ceiling is needed), so the Report carries the
   * poll's chain-named timeout message rather than a racing Step abort.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain whose epoch the gate watches.
   * @returns The gate step.
   */
  export function planAwaitEpochAdvanced<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: Constants.OutpostChainCodename
  ): ClusterBuildStep<C, AwaitEpochAdvancedInput> {
    return ClusterBuildStep.create<C, AwaitEpochAdvancedInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochAdvanceSteps.AwaitEpochAdvancedInput", chain },
      runAwaitEpochAdvanced
    )
  }

  /**
   * Named runner — poll until the input chain's `current_epoch_index` reaches
   * {@link BootstrapAdvanceTargetIndex}, within {@link epochAdvanceBudgetMs} of the chain.
   * Only that chain's index decides: another chain advancing does not satisfy it.
   *
   * @param ctx - The build context.
   * @param input - The chain whose epoch the gate watches.
   * @param signal - Abort signal.
   * @throws When the chain's epoch has not reached the target by the deadline.
   */
  export async function runAwaitEpochAdvanced<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitEpochAdvancedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chain } = input
    await pollEpochIndices(
      ctx,
      `the ${chain} current_epoch_index reaches ${BootstrapAdvanceTargetIndex}`,
      indices => indices[chain] >= BootstrapAdvanceTargetIndex,
      epochAdvanceBudgetMs(ctx.config, chain)
    )
  }

  // ── Wait: every chain advances past a snapshot ───────────────────────────

  /**
   * Wait until EVERY outpost chain's epoch index is past its index in `before`
   * (`EpochContractSteps.everyChainAdvancedPast`), within {@link everyChainAdvanceBudgetMs}: a
   * read, shared by {@link runVerifyEpochIndicesAdvanced} and `ClusterManager.run`'s relaunch
   * liveness gate.
   *
   * @param ctx - The build context.
   * @param before - Each outpost chain's index to advance past.
   * @throws When some chain has not advanced past its index by the deadline.
   */
  export async function awaitEpochIndicesAdvanced<C extends ClusterBuildContext>(
    ctx: C,
    before: Readonly<PerOutpostChain<number>>
  ): Promise<void> {
    await pollEpochIndices(
      ctx,
      `every outpost chain's current_epoch_index advances past ${describeOutpostChains(before)}`,
      indices => EpochContractSteps.everyChainAdvancedPast(indices, before),
      everyChainAdvanceBudgetMs(ctx.config)
    )
  }

  // ── Step: record every chain's epoch index ───────────────────────────────

  /** Name prefix of every {@link epochIndicesKey}; the snapshot's name follows it. */
  export const EpochIndicesKeyPrefix = "EpochAdvanceSteps.epochIndices."

  /**
   * The `ctx.outputs` key a snapshot of every chain's epoch index is stored under, one per name,
   * so one scenario can keep several apart.
   *
   * @param snapshotName - The snapshot's name within the scenario.
   * @returns The typed key.
   */
  export function epochIndicesKey(
    snapshotName: string
  ): OutputKey<PerOutpostChain<number>> {
    return outputKey<PerOutpostChain<number>>(
      `${EpochIndicesKeyPrefix}${snapshotName}`,
      `every outpost chain's current_epoch_index, recorded as "${snapshotName}"`
    )
  }

  /** Input for {@link planRecordEpochIndices}. */
  export interface RecordEpochIndicesInput extends StepInput {
    readonly kind: "EpochAdvanceSteps.RecordEpochIndicesInput"
    /** The name the snapshot is stored under ({@link epochIndicesKey}). */
    readonly snapshotName: string
  }

  /**
   * Record every outpost chain's `current_epoch_index` now under {@link epochIndicesKey} — a
   * read, carried by a Step because a later {@link planVerifyEpochIndicesAdvanced} compares
   * against it. Every chain must have started its consensus epoch.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param snapshotName - The name the snapshot is stored under.
   * @returns The record step.
   */
  export function planRecordEpochIndices<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    snapshotName: string
  ): ClusterBuildStep<C, RecordEpochIndicesInput> {
    return ClusterBuildStep.create<C, RecordEpochIndicesInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochAdvanceSteps.RecordEpochIndicesInput", snapshotName },
      runRecordEpochIndices
    )
  }

  /**
   * Named runner — read every chain's index, assert each has started, store the snapshot.
   *
   * @param ctx - The build context.
   * @param input - The snapshot's name.
   * @param signal - Abort signal.
   * @throws When a chain's consensus epoch has not started (index 0): advancing past 0 proves
   *   only its genesis advance, never circulation.
   */
  export async function runRecordEpochIndices<C extends ClusterBuildContext>(
    ctx: C,
    input: RecordEpochIndicesInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const indices = await EpochContractSteps.readCurrentEpochIndices(ctx)
    OutpostChainCodenames.forEach(chain =>
      Assert.ok(
        indices[chain] >= 1,
        `EpochAdvanceSteps: the ${chain} consensus epoch has not started — the bootstrap's EpochBootstrap must precede the snapshot`
      )
    )
    ctx.outputs.set(epochIndicesKey(input.snapshotName), indices)
  }

  // ── Step: verify every chain advanced past the snapshot ──────────────────

  /** Input for {@link planVerifyEpochIndicesAdvanced}. */
  export interface VerifyEpochIndicesAdvancedInput extends StepInput {
    readonly kind: "EpochAdvanceSteps.VerifyEpochIndicesAdvancedInput"
    /** The snapshot every chain must advance past ({@link epochIndicesKey}). */
    readonly snapshotName: string
  }

  /**
   * Assert every outpost chain's epoch advances past its index in a recorded snapshot
   * ({@link awaitEpochIndicesAdvanced}): a poll, so it returns the moment the slowest chain
   * moves. Pair it with `ProtocolTiming.pollStepOptions(everyChainAdvanceBudgetMs(config))` for
   * the Step's ceiling.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param snapshotName - The snapshot every chain must advance past.
   * @returns The verify step.
   */
  export function planVerifyEpochIndicesAdvanced<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    snapshotName: string
  ): ClusterBuildStep<C, VerifyEpochIndicesAdvancedInput> {
    return ClusterBuildStep.create<C, VerifyEpochIndicesAdvancedInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochAdvanceSteps.VerifyEpochIndicesAdvancedInput", snapshotName },
      runVerifyEpochIndicesAdvanced
    )
  }

  /**
   * Named runner — read the snapshot back and wait for every chain to advance past it.
   *
   * @param ctx - The build context.
   * @param input - The snapshot's name.
   * @param signal - Abort signal.
   * @throws When the snapshot was never recorded, or a chain has not advanced by the deadline.
   */
  export async function runVerifyEpochIndicesAdvanced<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyEpochIndicesAdvancedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await awaitEpochIndicesAdvanced(
      ctx,
      ctx.outputs.assert(epochIndicesKey(input.snapshotName))
    )
  }
}
