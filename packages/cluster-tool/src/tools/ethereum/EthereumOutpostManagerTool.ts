/**
 * EthereumOutpostManagerTool — Step factories for `OutpostManager`'s
 * AccessManager administration surface on the Ethereum outpost.
 *
 * `OutpostManager.grantRole(role, grantee)` is `restricted` and forwards to the
 * `OutpostManagerAuthority` (an OpenZeppelin `AccessManager`); only the deploy
 * owner — anvil HD index 0, which `deployLocal.ts` leaves holding ADMIN_ROLE and
 * which `ctx.ethereum.wallet.signer` is bound to — may call it.
 *
 * The one grant this tool exists for is the WNE-41 genesis-delivery
 * authorization; see {@link EthereumOutpostManagerTool.planGrantBootstrapDelivery}.
 */

import Assert from "node:assert"
import { ethers } from "ethers"

import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { Report } from "../../report/Report.js"
import {
  EvmAddressPattern,
  loadOutpostContract,
  resolveLatestNonce
} from "../../utils/ethereumUtils.js"
import { EthereumCollateralTool } from "./EthereumCollateralTool.js"

/**
 * Structural surface of the `OutpostManager` members this tool binds — the
 * AccessManager grant forwarder and the `epochIn` role constant it grants.
 */
export interface OutpostManagerContract extends ethers.BaseContract {
  /** Forwards to `AccessManager.grantRole(role, grantee, 0)`; `restricted`. */
  grantRole: (
    role: bigint,
    grantee: string,
    overrides?: ethers.Overrides
  ) => Promise<ethers.ContractTransactionResponse>
  /** `OutpostManagerCommon.OPP_INBOUND_ROLE` — the `epochIn` role id. */
  OPP_INBOUND_ROLE: () => Promise<bigint>
  getAddress: () => Promise<string>
}

export namespace EthereumOutpostManagerTool {
  /** Input for {@link planGrantBootstrapDelivery} — ONE `grantRole` write. */
  export interface GrantBootstrapDeliveryInput extends StepInput {
    readonly kind: "EthereumOutpostManagerTool.GrantBootstrapDeliveryInput"
    /** Operator's durable `label` handle — resolved from `ctx.keyStore` (NOT its on-chain `account`). */
    readonly operatorLabel: string
  }

  /**
   * Authorize ONE operator's Ethereum EOA to deliver the genesis envelope —
   * `OutpostManager.grantRole(OPP_INBOUND_ROLE, <operator ETH address>)`.
   *
   * WNE-41: while the outpost's genesis bootstrap window is open
   * (`OPPInbound.rosterInitialized == false`) there is no batch-operator roster
   * to authorize against, so `epochIn` authorizes on the AccessManager instead.
   * `OutpostManager.setupOPPRoles` registers the `epochIn` selector under
   * `OPP_INBOUND_ROLE` and grants that role to NOBODY, so without this step
   * epoch 1 reverts `AccessManagedUnauthorized` for every caller, the outpost
   * never reaches consensus, the depot's `chkcons` never fires `advance`, and
   * every flow dies on an epoch stall.
   *
   * The grantee is the operator's OWN EOA, because that is what actually sends
   * the transaction: `outpost_ethereum_client_plugin`'s
   * `deliver_outbound_envelope` calls `epochIn` signed with the daemon's key,
   * and the gate reads `msg.sender`. `deployLocal.ts`'s deployer grant does NOT
   * cover it — the deployer is anvil HD index 0 and the batch operators are HD
   * index 1..N (and under an SSM signature provider their keys come off a
   * generated mnemonic that has no relationship to the anvil one at all).
   *
   * This runs AFTER operator provisioning by necessity: the accounts do not
   * exist when the outpost deploys. It is inert the moment the roster installs —
   * `epochIn` stops consulting the AccessManager and the window never reopens —
   * so nothing revokes it.
   *
   * @param actor Report actor the step is attributed to.
   * @param name Step name as it appears in the Report.
   * @param description Human-readable step description.
   * @param options Step options (timeout, retry, …).
   * @param operatorLabel Durable harness handle of the operator to authorize.
   * @returns The step performing the one `grantRole` write.
   */
  export function planGrantBootstrapDelivery<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string
  ): ClusterBuildStep<C, GrantBootstrapDeliveryInput> {
    return ClusterBuildStep.create<C, GrantBootstrapDeliveryInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EthereumOutpostManagerTool.GrantBootstrapDeliveryInput",
        operatorLabel
      },
      runGrantBootstrapDelivery
    )
  }

  /** Named runner — ONE `OutpostManager.grantRole(...)` write, signed by the deploy owner. */
  export async function runGrantBootstrapDelivery<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: GrantBootstrapDeliveryInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.operatorLabel)
    const grantee = operator.ethereum?.address
    Assert.ok(
      grantee != null && EvmAddressPattern.test(grantee),
      `EthereumOutpostManagerTool.planGrantBootstrapDelivery: ` +
        `operator ${input.operatorLabel} has no Ethereum address (got ${grantee})`
    )

    const manager = loadOutpostManager(ctx)
    const role = await manager.OPP_INBOUND_ROLE()
    const nonce = await resolveLatestNonce(manager)
    const response = await manager.grantRole(role, grantee, { nonce })
    const receipt = await response.wait(1)
    Assert.ok(
      receipt?.status === 1,
      `EthereumOutpostManagerTool.planGrantBootstrapDelivery: reverted for ` +
        `${input.operatorLabel} (${grantee}, status=${receipt?.status ?? "null"})`
    )
  }

  /**
   * Resolve the deployed `OutpostManager` from THIS cluster's deploy artifacts,
   * bound to the deploy owner (`ctx.ethereum.wallet.signer`, anvil HD index 0) —
   * the only identity holding ADMIN_ROLE on the outpost's AccessManager, and so
   * the only one `grantRole`'s `restricted` modifier admits.
   *
   * @param ctx Build context carrying the cluster config + Ethereum client.
   * @returns The owner-bound `OutpostManager` surface.
   */
  export function loadOutpostManager<C extends ClusterBuildContext>(
    ctx: C
  ): OutpostManagerContract {
    return loadOutpostContract<OutpostManagerContract>(
      ctx.config.ethereumPath,
      EthereumCollateralTool.loadOutpostAddresses(
        ClusterConfigProvider.ethereumDeploymentsPath(ctx.config)
      ),
      "OutpostManager",
      ["outpost"],
      ctx.ethereum.wallet.signer
    )
  }
}
