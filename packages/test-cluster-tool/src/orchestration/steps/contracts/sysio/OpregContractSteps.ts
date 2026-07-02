import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.opreg` (operator registry) actions. */
export namespace OpregContractSteps {
  /** Input for {@link setconfig} — the generated `opreg::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "OpregContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioOpregSetconfigAction
  }

  /** `sysio.opreg::setconfig` — availability caps, termination thresholds, collateral minimums. */
  export function setconfig<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregSetconfigAction
  ): ClusterBuildStep<C, SetconfigInput> {
    return ClusterBuildStep.create<C, SetconfigInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.SetconfigInput", data },
      runSetconfig
    )
  }

  /** Named runner — `sysio.opreg::setconfig`. */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    input: SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.setconfig.invoke(input.data)
  }

  /** Input for {@link regoperator} — the generated `opreg::regoperator` data. */
  export interface RegoperatorInput extends StepInput {
    readonly kind: "OpregContractSteps.RegoperatorInput"
    readonly data: SysioContracts.SysioOpregRegoperatorAction
  }

  /** `sysio.opreg::regoperator` — register a batch operator / underwriter / producer. */
  export function regoperator<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregRegoperatorAction
  ): ClusterBuildStep<C, RegoperatorInput> {
    return ClusterBuildStep.create<C, RegoperatorInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.RegoperatorInput", data },
      runRegoperator
    )
  }

  /** Named runner — `sysio.opreg::regoperator`. */
  export async function runRegoperator<C extends ClusterBuildContext>(
    ctx: C,
    input: RegoperatorInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.regoperator.invoke(input.data)
  }
}
