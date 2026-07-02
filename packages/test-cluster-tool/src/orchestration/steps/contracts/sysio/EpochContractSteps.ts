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
 * names match the ABI action name exactly.
 */
export namespace EpochContractSteps {
  /** Input for {@link setconfig} — the generated `epoch::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "EpochContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioEpochSetconfigAction
  }

  /** `sysio.epoch::setconfig` — global epoch duration, group sizing, retention. */
  export function setconfig<C extends ClusterBuildContext = ClusterBuildContext>(
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
  export function schbatchgps<C extends ClusterBuildContext = ClusterBuildContext>(
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
  export function advance<C extends ClusterBuildContext = ClusterBuildContext>(
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
}
