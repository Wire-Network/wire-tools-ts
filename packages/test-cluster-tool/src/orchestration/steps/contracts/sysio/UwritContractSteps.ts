import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.uwrit` (underwriting) actions. */
export namespace UwritContractSteps {
  /** Input for {@link setconfig} — the generated `uwrit::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "UwritContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioUwritSetconfigAction
  }

  /** `sysio.uwrit::setconfig` — WIRE-leg swap fee + collateral-lock challenge window. */
  export function setconfig<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioUwritSetconfigAction
  ): ClusterBuildStep<C, SetconfigInput> {
    return ClusterBuildStep.create<C, SetconfigInput>(
      actor,
      name,
      description,
      options,
      { kind: "UwritContractSteps.SetconfigInput", data },
      runSetconfig
    )
  }

  /** Named runner — `sysio.uwrit::setconfig`. */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    input: SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.uwrit)
      .actions.setconfig.invoke(input.data)
  }
}
