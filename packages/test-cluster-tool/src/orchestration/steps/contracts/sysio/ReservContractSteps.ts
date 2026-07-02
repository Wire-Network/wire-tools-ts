import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.reserv` actions. */
export namespace ReservContractSteps {
  /** Input for {@link regreserve} — the generated `reserv::regreserve` data. */
  export interface RegreserveInput extends StepInput {
    readonly kind: "ReservContractSteps.RegreserveInput"
    readonly data: SysioContracts.SysioReservRegreserveAction
  }

  /** `sysio.reserv::regreserve` — seed one `(chain, token, reserve)` reserve book. */
  export function regreserve<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioReservRegreserveAction
  ): ClusterBuildStep<C, RegreserveInput> {
    return ClusterBuildStep.create<C, RegreserveInput>(
      actor,
      name,
      description,
      options,
      { kind: "ReservContractSteps.RegreserveInput", data },
      runRegreserve
    )
  }

  /** Named runner — `sysio.reserv::regreserve`. */
  export async function runRegreserve<C extends ClusterBuildContext>(
    ctx: C,
    input: RegreserveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.reserv)
      .actions.regreserve.invoke(input.data)
  }
}
