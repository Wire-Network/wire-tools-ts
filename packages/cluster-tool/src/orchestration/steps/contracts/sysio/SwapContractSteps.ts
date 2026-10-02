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
 * Steps for `sysio.swap` actions — the depot swap the shadow liq yield pools
 * live on. Signed by the contract, the client's default authorization.
 */
export namespace SwapContractSteps {
  /** Input for {@link planSetconfig} — the generated `swap::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "SwapContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioSwapSetconfigAction
  }

  /**
   * `sysio.swap::setconfig` — the deployment's configuration step: the
   * contract-wide fee authority (governance, which executes as the system
   * account) and the system token every pair's second leg is quoted in.
   */
  export function planSetconfig<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSwapSetconfigAction
  ): ClusterBuildStep<C, SetconfigInput> {
    return ClusterBuildStep.create<C, SetconfigInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapContractSteps.SetconfigInput", data },
      runSetconfig
    )
  }

  /** Named runner — `sysio.swap::setconfig`. */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    input: SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.swap)
      .actions.setconfig.invoke(input.data)
  }
}
