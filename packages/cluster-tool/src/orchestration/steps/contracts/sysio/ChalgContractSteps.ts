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

/** Steps for `sysio.chalg` (challenge and dispute) actions. */
export namespace ChalgContractSteps {
  /** Input for {@link planVotedispute} — the generated `chalg::votedispute` data. */
  export interface VotedisputeInput extends StepInput {
    readonly kind: "ChalgContractSteps.VotedisputeInput"
    readonly data: SysioContracts.SysioChalgVotedisputeAction
  }

  /**
   * `sysio.chalg::votedispute` — vote for a candidate in an open dispute.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param data - Generated vote action data.
   * @returns The definition step.
   */
  export function planVotedispute<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioChalgVotedisputeAction
  ): ClusterBuildStep<C, VotedisputeInput> {
    return ClusterBuildStep.create<C, VotedisputeInput>(
      actor,
      name,
      description,
      options,
      { kind: "ChalgContractSteps.VotedisputeInput", data },
      runVotedispute
    )
  }

  /**
   * Run `sysio.chalg::votedispute`, signed by the Tier-1 owner.
   *
   * @param ctx - The build context.
   * @param input - Generated vote action data from the definition step.
   * @param signal - Abort signal checked before invoking the action.
   * @returns A promise that resolves after the action reaches finality.
   */
  export async function runVotedispute<C extends ClusterBuildContext>(
    ctx: C,
    input: VotedisputeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.chalg)
      .actions.votedispute.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.owner)
      })
  }
}
