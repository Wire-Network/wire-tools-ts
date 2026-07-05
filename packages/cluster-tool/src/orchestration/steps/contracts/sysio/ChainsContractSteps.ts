import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.chains` actions. */
export namespace ChainsContractSteps {
  /** Input for {@link planRegchain} — the generated `chains::regchain` data. */
  export interface RegchainInput extends StepInput {
    readonly kind: "ChainsContractSteps.RegchainInput"
    readonly data: SysioContracts.SysioChainsRegchainAction
  }

  /** `sysio.chains::regchain` — register one chain (WIRE / EVM / SVM). */
  export function planRegchain<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioChainsRegchainAction
  ): ClusterBuildStep<C, RegchainInput> {
    return ClusterBuildStep.create<C, RegchainInput>(
      actor,
      name,
      description,
      options,
      { kind: "ChainsContractSteps.RegchainInput", data },
      runRegchain
    )
  }

  /** Named runner — `sysio.chains::regchain`. */
  export async function runRegchain<C extends ClusterBuildContext>(
    ctx: C,
    input: RegchainInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.chains)
      .actions.regchain.invoke(input.data)
  }
}
