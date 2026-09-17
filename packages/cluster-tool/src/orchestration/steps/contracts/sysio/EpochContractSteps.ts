import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/**
 * Steps for `sysio.epoch` actions — the Step-layer mirror of
 * `getSysioContract(SysioContractName.epoch).actions.<action>`. Action factory
 * names match the ABI action name exactly. The trailing "Reads" section holds
 * the `sysio.epoch::epochstate` accessors every runner / verify step shares —
 * reads are execution details, not Steps.
 */
export namespace EpochContractSteps {
  /** Input for {@link planSetconfig} — the generated `epoch::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "EpochContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioEpochSetconfigAction
  }

  /** `sysio.epoch::setconfig` — global epoch duration, group sizing, retention. */
  export function planSetconfig<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioEpochSetconfigAction
  ): ClusterBuildStep<C, SetconfigInput> {
    return ClusterBuildStep.create<C, SetconfigInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochContractSteps.SetconfigInput", data },
      runSetconfig
    )
  }

  /** Named runner — `sysio.epoch::setconfig`. */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    input: SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.setconfig.invoke(input.data)
  }

  /** `sysio.epoch::schbatchgps` — build the initial batch-operator group schedule. */
  export function planSchbatchgps<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runSchbatchgps
    )
  }

  /** Named runner — `sysio.epoch::schbatchgps` (empty payload). */
  export async function runSchbatchgps<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.schbatchgps.invoke({})
  }

  /** `sysio.epoch::advance` — advance the depot epoch. */
  export function planAdvance<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runAdvance
    )
  }

  /** Named runner — `sysio.epoch::advance` (empty payload). */
  export async function runAdvance<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.getSysioContract(SysioContractName.epoch).actions.advance.invoke({})
  }

  // ── Reads (execute freely inside runners / verify steps) ─────────────────

  /**
   * The `sysio.epoch::epochstate` singleton row.
   *
   * @param ctx - The build context.
   * @returns The epoch-state row (absent before the depot bootstraps it).
   */
  export async function readEpochState<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioEpochEpochStateType> {
    const { rows } = await ctx.wire.getEpochState()
    return rows[0]
  }

  /**
   * The depot's whole sliding-window batch-operator schedule — every group,
   * `[current, next, next+1]` at the default `batch_op_groups` of 3.
   *
   * @param ctx - The build context.
   * @returns The schedule groups (empty when the epoch state has no row yet).
   */
  export async function batchOperatorGroups<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<string[][]> {
    return (await readEpochState(ctx))?.batch_op_groups ?? []
  }

  /**
   * The ACTIVE batch-operator group — `batch_op_groups[current_batch_op_group]`.
   * THE one way to read "who is scheduled right now": the window rotates, so the
   * active group is at the cursor, never a hardcoded `[0]`.
   *
   * @param ctx - The build context.
   * @returns The active group's account names (absent when no schedule exists).
   */
  export async function activeBatchOperatorGroup<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<string[]> {
    const epochState = await readEpochState(ctx)
    return epochState?.batch_op_groups?.[epochState.current_batch_op_group]
  }
}
