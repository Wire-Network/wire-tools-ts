import { provisionWireUser } from "@wireio/test-cluster-tool"
import {
  createStressIdentities,
  SwapStressPhaseAmounts
} from "@wireio/test-flow-swap-stress-saturation"

import { Accounts, RealRamp } from "./realFlowConstants.js"
import type { FlowTestContext, WireUser } from "@wireio/test-cluster-tool"

type StressWireAccountProvisioner = (account: string) => Promise<WireUser>

/** WIRE funding per generated stress account across all configured ramp iterations. */
export const StressWireAccountFunding =
  SwapStressPhaseAmounts.Phase2SourceWireUnits *
  BigInt(RealRamp.MaxIterationCount)

/**
 * Provision generated stress WIRE accounts sequentially so each ROA policy action observes the prior account creation.
 *
 * @param provisioner account provisioner invoked once per generated stress account.
 */
export async function provisionStressWireAccountsWith(
  provisioner: StressWireAccountProvisioner
): Promise<void> {
  await createStressIdentities(RealRamp.Config.maxCount).wire.reduce(
    (previous, identity) => previous.then(() => provisioner(identity.account)),
    Promise.resolve<WireUser | void>(undefined)
  )
}

/**
 * Provision generated stress WIRE accounts with phase-2 funds and the stress resource policy.
 *
 * @param context real flow context with the WIRE client used for account provisioning.
 */
export async function provisionStressWireAccounts(
  context: FlowTestContext
): Promise<void> {
  await provisionStressWireAccountsWith(account =>
    provisionWireUser(context.wireClient.clio, account, {
      fundWireAmount: StressWireAccountFunding,
      resourcePolicy: Accounts.StressUserPolicy
    })
  )
}
