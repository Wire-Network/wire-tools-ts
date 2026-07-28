import {
  ClusterBuildPhase,
  ClusterBuildStep,
  Report,
  provisionWireUser,
  type ClusterBuildContext,
  type ClusterBuildParent,
  type ClusterBuildStepOptions,
  type StepInput,
  type WireUserResourcePolicy
} from "@wireio/cluster-tool"
import { SwapStressSaturationScenarioConstants as Constants } from "../SwapStressSaturationScenarioConstants.js"
import { createStressIdentities } from "@wireio/opp-swap-stress"

/**
 * Stress-user provisioning: the deterministic WIRE accounts the ramp campaign
 * reuses as `swapfromwire` recipients. Each account is created + funded by ONE
 * Step (one per account, per the one-atomic-step-per-unit-of-work rule); the
 * account NAMES derive from the same `createStressIdentities` the campaign
 * derives its identities from, so setup and campaign address the same accounts.
 */
export namespace SwapStressSaturationScenarioUserSteps {
  /** Input for {@link planProvisionStressAccount}. */
  export interface ProvisionStressAccountInput extends StepInput {
    readonly kind: "SwapStressSaturationScenarioUserSteps.ProvisionStressAccountInput"
    /** The stress WIRE account name. */
    readonly account: string
    /** Raw 9-dp WIRE funding (sources the account's swapfromwire per iteration). */
    readonly fundWireAmount: bigint
    /** Lightweight ROA policy — the roster is too large for the harness default. */
    readonly resourcePolicy: WireUserResourcePolicy
  }

  /**
   * Provision ONE stress WIRE account — create it under the dev key and fund it
   * with enough WIRE to source its `swapfromwire` across every ramp iteration
   * (via the harness's `provisionWireUser`).
   */
  export function planProvisionStressAccount<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    fundWireAmount: bigint
  ): ClusterBuildStep<C, ProvisionStressAccountInput> {
    return ClusterBuildStep.create<C, ProvisionStressAccountInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapStressSaturationScenarioUserSteps.ProvisionStressAccountInput",
        account,
        fundWireAmount,
        resourcePolicy: Constants.StressAccounts.Policy
      },
      runProvisionStressAccount
    )
  }

  /** Named runner — ONE account create + WIRE funding. */
  export async function runProvisionStressAccount<C extends ClusterBuildContext>(
    ctx: C,
    input: ProvisionStressAccountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await provisionWireUser(ctx.wire, input.account, {
      fundWireAmount: input.fundWireAmount,
      resourcePolicy: input.resourcePolicy
    })
  }

  /**
   * The stress-account provisioning Phase — one {@link planProvisionStressAccount}
   * Step per deterministic account. The account names come from
   * `createStressIdentities(count).wire` (the same source the campaign uses), so
   * every provisioned account is one the ramp will drive.
   *
   * @param parent - The build the phase self-registers on.
   * @param count - How many deterministic stress accounts to provision.
   * @param fundWireAmount - Raw 9-dp WIRE funding per account.
   */
  export function planProvisionStressAccounts<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    count: number,
    fundWireAmount: bigint
  ): ClusterBuildPhase<C> {
    const accounts = createStressIdentities(count).wire
    return ClusterBuildPhase.create<C>(
      parent,
      name,
      description,
      accounts.map(identity =>
        planProvisionStressAccount<C>(
          Report.Actor.User,
          `provision-${identity.account}`,
          `create + fund stress WIRE account ${identity.account}`,
          options,
          identity.account,
          fundWireAmount
        )
      )
    )
  }
}
