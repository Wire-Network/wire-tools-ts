import { SysioContracts } from "@wireio/sdk-core"
import { WireClient } from "../../../../clients/wire/WireClient.js"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/**
 * Steps for `sysio.councl` actions — the council election contract, which also
 * maintains the two governance authorities `sysio` can be handed to.
 */
export namespace CounclContractSteps {
  /** Input for {@link planSyncnodes} — the generated `sysio.councl::syncnodes` data. */
  export interface SyncnodesInput extends StepInput {
    readonly kind: "CounclContractSteps.SyncnodesInput"
    readonly data: SysioContracts.SysioCounclSyncnodesAction
  }

  /**
   * `sysio.councl::syncnodes` — replace `sysio.nodes@active` with the current
   * `sysio.roa` tier-1 node owners, each through its `active` permission at
   * weight 1, at a threshold of `floor(2N/3)+1`. A public crank any account
   * may call; it fails while no tier-1 owner is registered. Signed by
   * `caller@active`.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The calling account.
   * @returns The definition step.
   */
  export function planSyncnodes<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioCounclSyncnodesAction
  ): ClusterBuildStep<C, SyncnodesInput> {
    return ClusterBuildStep.create<C, SyncnodesInput>(
      actor,
      name,
      description,
      options,
      { kind: "CounclContractSteps.SyncnodesInput", data },
      runSyncnodes
    )
  }

  /** Named runner — `sysio.councl::syncnodes`, signed by the caller. */
  export async function runSyncnodes<C extends ClusterBuildContext>(
    ctx: C,
    input: SyncnodesInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.councl)
      .actions.syncnodes.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.caller)
      })
  }
}
