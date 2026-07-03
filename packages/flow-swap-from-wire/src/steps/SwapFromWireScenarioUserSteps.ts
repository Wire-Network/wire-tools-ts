import {
  ClusterBuildStep,
  provisionWireUser,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type Report,
  type StepInput
} from "@wireio/test-cluster-tool"

/**
 * Flow-local user Steps — WIRE-side depositor provisioning. The harness ships
 * {@link provisionWireUser} as flow-layer plumbing (create account + resource
 * policy + optional treasury funding); this factory lifts it into ONE
 * Report-validated `ClusterBuildStep` per the plan's `Steps.user.provisionWire`
 * shape.
 */
export namespace SwapFromWireScenarioUserSteps {
  /** Input for {@link planProvisionWire}. */
  export interface ProvisionWireInput extends StepInput {
    readonly kind: "SwapFromWireScenarioUserSteps.ProvisionWireInput"
    /** WIRE account name to provision. */
    readonly account: string
    /** Raw 9-dec WIRE base units funded from the `sysio` treasury. */
    readonly fundWireAmount: bigint
  }

  /**
   * Provision a WIRE user account and fund it from the treasury.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param account - WIRE account name to provision.
   * @param fundWireAmount - Treasury funding in raw WIRE base units.
   * @returns The definition step.
   */
  export function planProvisionWire<C extends ClusterBuildContext = ClusterBuildContext>(
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
      { kind: "SwapFromWireScenarioUserSteps.ProvisionWireInput", account, fundWireAmount },
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
