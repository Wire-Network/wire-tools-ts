import { Report } from "../../report/Report.js"
import { provisionWireUser } from "../../tools/wire/WireUserTool.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"

/**
 * Steps that provision the WIRE-side user identities a flow scenario acts
 * as: a swap depositor, a swap-to-WIRE recipient, a reserve owner, a liq
 * holder. The harness ships {@link provisionWireUser} as the flow-layer
 * plumbing (create the account under the dev key, attach the resource
 * policy, optionally fund it from the treasury); these factories lift it
 * into ONE Report-validated step per user.
 */
export namespace UserSteps {
  /** Input for {@link planProvisionWire}. */
  export interface ProvisionWireInput extends StepInput {
    readonly kind: "UserSteps.ProvisionWireInput"
    /** WIRE account name to provision. */
    readonly account: string
    /** Raw 9-dec WIRE base units funded from the `sysio` treasury; `0n` creates the account unfunded. */
    readonly fundWireAmount: bigint
  }

  /**
   * Provision a WIRE user account, funded from the treasury when
   * `fundWireAmount` is positive.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param account - WIRE account name to provision.
   * @param fundWireAmount - Treasury funding in raw WIRE base units.
   * @returns The definition step.
   */
  export function planProvisionWire<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    fundWireAmount: bigint
  ): ClusterBuildStep<C, ProvisionWireInput> {
    return ClusterBuildStep.create<C, ProvisionWireInput>(
      actor,
      name,
      description,
      options,
      { kind: "UserSteps.ProvisionWireInput", account, fundWireAmount },
      runProvisionWire
    )
  }

  /** Named runner — create + policy + fund via {@link provisionWireUser}. */
  export async function runProvisionWire<C extends ClusterBuildContext>(
    ctx: C,
    input: ProvisionWireInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await provisionWireUser(ctx.wire, input.account, {
      fundWireAmount: input.fundWireAmount
    })
  }
}
