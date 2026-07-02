import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"

const { SysioContractName } = SysioContracts

/**
 * Operator registration on `sysio.opreg`. The raw single action
 * `opreg::regoperator` also lives at `Steps.contracts.sysio.opreg.regoperator`;
 * {@link register} here is the typed convenience carrying the same action data.
 *
 * Authex chain-linking is NOT here — it lives in the one operator-provisioning
 * mechanism (`WireOperatorProvisioningTool`), which resolves each operator's chain
 * keys from its `OperatorAccount` (the unified per-account operator store).
 */
export namespace OperatorSteps {
  /** Input for {@link register} — the generated `opreg::regoperator` data. */
  export interface RegisterInput extends StepInput {
    readonly kind: "OperatorSteps.RegisterInput"
    readonly data: SysioContracts.SysioOpregRegoperatorAction
  }

  /** Register an operator on `sysio.opreg` (`regoperator`). */
  export function register<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregRegoperatorAction
  ): ClusterBuildStep<C, RegisterInput> {
    return ClusterBuildStep.create<C, RegisterInput>(
      actor,
      name,
      description,
      options,
      { kind: "OperatorSteps.RegisterInput", data },
      runRegister
    )
  }

  /** Named runner — `sysio.opreg::regoperator`. */
  export async function runRegister<C extends ClusterBuildContext>(
    ctx: C,
    input: RegisterInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.regoperator.invoke(input.data)
  }
}
