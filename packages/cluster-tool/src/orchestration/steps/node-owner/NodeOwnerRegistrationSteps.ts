import { EthereumWallet } from "../../../clients/ethereum/EthereumWallet.js"
import { Report } from "../../../report/Report.js"
import {
  NodeOwnerTier,
  pushNewNamedUser,
  pushNodeOwnerReg
} from "../../../tools/ethereum/EthereumNodeOwnerNftTool.js"
import type { EthereumIdentity } from "../../../types/KeyPair.js"
import { ClusterBuildContext } from "../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../ClusterBuildStep.js"
import type { StepInput } from "../../StepRunner.js"

/**
 * Registration writes for fresh claims and pre-existing-account rejection fixtures.
 * Each write is its own Step; nodeownreg owns atomic creation, registration and linkage.
 * Claim rejections commit an audit row and are checked by the following verify step.
 *
 * A claim's depositor EM key is a RANDOM wallet persisted under the claim's
 * durable handle by `EthereumFundingTool.planCreateWallet`, one Step before
 * the claim; the registration runner and the hard-abort probes read it back
 * by that handle ({@link loadDepositorIdentity}). A rejection fixture's
 * pre-existing Ethereum link is another persisted wallet, linked by the
 * fixture account's own `sysio.authex::createlink`
 * (`SyndicationUserSteps.planLinkEthereumKey`) before the claim.
 *
 * Before a governance handoff `sysio.roa@active` is the bootstrap `sysio` key,
 * so these writes stand in for the depot's dispatch; after one, an owner claims
 * through the OPP path ({@link NodeOwnerCommitSteps}).
 */
export namespace NodeOwnerRegistrationSteps {
  /** Length of the `0x` prefix an EVM address carries in display form. */
  const EvmHexPrefixLength = 2

  /**
   * A claim's depositor identity — the `PUB_EM_*` public key and the raw
   * address `nodeownreg` takes — read back from the wallet persisted under
   * `walletName`. A pure value helper: used inside the
   * {@link planRegisterNodeOwner} runner and the scenario's hard-abort probes.
   *
   * @param ctx - The build context (supplies the cluster data directory).
   * @param walletName - Durable handle of the claim's depositor wallet.
   * @returns The depositor identity.
   * @throws If no wallet is persisted under `walletName`.
   */
  export function loadDepositorIdentity<C extends ClusterBuildContext>(
    ctx: C,
    walletName: string
  ): EthereumIdentity {
    const pair = EthereumWallet.loadKeyPair(ctx.config.dataPath, walletName)
    return {
      publicKey: pair.publicKey,
      nativeAddress: pair.address.slice(EvmHexPrefixLength).toLowerCase()
    }
  }

  /**
   * A claim's depositor `PUB_EM_*` public key, read back from the wallet
   * persisted under `walletName` (see {@link loadDepositorIdentity}).
   *
   * @param ctx - The build context (supplies the cluster data directory).
   * @param walletName - Durable handle of the claim's depositor wallet.
   * @returns The depositor's `PUB_EM_*` public key.
   */
  export function loadDepositorPublicKey<C extends ClusterBuildContext>(
    ctx: C,
    walletName: string
  ): string {
    return loadDepositorIdentity(ctx, walletName).publicKey
  }

  /** Input for {@link planCreateNamedUser} — one `sysio.roa::newnameduser` write. */
  export interface CreateNamedUserInput extends StepInput {
    readonly kind: "NodeOwnerRegistrationSteps.CreateNamedUserInput"
    /** The vanity account to create (tier-1 names are a 2-6 char prefix). */
    readonly account: string
    /** The holder's Wire owner/active public key (`PUB_K1_*`). */
    readonly wirePublicKey: string
    /** The claim tier the name is validated against. */
    readonly tier: NodeOwnerTier
  }

  /**
   * A privileged pre-existing-account fixture, ineligible for node-owner claims.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param account - The vanity account to create.
   * @param wirePublicKey - The holder's Wire owner/active public key.
   * @param tier - The claim tier the name is validated against.
   * @returns The definition step.
   */
  export function planCreateNamedUser<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    wirePublicKey: string,
    tier: NodeOwnerTier
  ): ClusterBuildStep<C, CreateNamedUserInput> {
    return ClusterBuildStep.create<C, CreateNamedUserInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "NodeOwnerRegistrationSteps.CreateNamedUserInput",
        account,
        wirePublicKey,
        tier
      },
      runCreateNamedUser
    )
  }

  /** Named runner — ONE `sysio.roa::newnameduser` write. */
  export async function runCreateNamedUser<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateNamedUserInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await pushNewNamedUser(
      ctx.wire,
      input.account,
      input.wirePublicKey,
      input.tier
    )
  }

  /** Input for {@link planRegisterNodeOwner} — one `sysio.roa::nodeownreg` write. */
  export interface RegisterNodeOwnerInput extends StepInput {
    readonly kind: "NodeOwnerRegistrationSteps.RegisterNodeOwnerInput"
    /** The Wire account the claim registers. */
    readonly ownerAccount: string
    /** The claimed tier (1-3 for valid claims). */
    readonly tier: NodeOwnerTier
    /** Durable handle of the persisted wallet whose EM key is the claim's depositor key. */
    readonly walletName: string
    /** The owner/active Wire key for the new account. */
    readonly wirePublicKey: string
  }

  /**
   * A single `sysio.roa::nodeownreg` write, as the depot inline-sends it.
   * Claim-payload problems (existing account / invalid name /
   * replay) soft-fail into a `nodeownerreg` audit row — the transaction
   * SUCCEEDS — so intentionally-bad claims are normal write steps too, with a
   * following verify step asserting the audit outcome. The depot/system
   * invariants (tier out of [1,3], non-EM eth key, malformed ETH address
   * length) hard-abort. The scenario probes tier and key type; focused C++
   * coverage exercises address length because the persisted wallet always
   * yields a valid Ethereum address.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param ownerAccount - The Wire account the claim registers.
   * @param tier - The claimed tier.
   * @param walletName - Durable handle of the claim's persisted depositor wallet.
   * @param wirePublicKey - The claimed owner/active Wire key.
   * @returns The definition step.
   */
  export function planRegisterNodeOwner<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ownerAccount: string,
    tier: NodeOwnerTier,
    walletName: string,
    wirePublicKey: string
  ): ClusterBuildStep<C, RegisterNodeOwnerInput> {
    return ClusterBuildStep.create<C, RegisterNodeOwnerInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "NodeOwnerRegistrationSteps.RegisterNodeOwnerInput",
        ownerAccount,
        tier,
        walletName,
        wirePublicKey
      },
      runRegisterNodeOwner
    )
  }

  /** Named runner — read the claim's depositor wallet back by handle, then ONE `sysio.roa::nodeownreg` write. */
  export async function runRegisterNodeOwner<C extends ClusterBuildContext>(
    ctx: C,
    input: RegisterNodeOwnerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const depositor = loadDepositorIdentity(ctx, input.walletName)
    await pushNodeOwnerReg(
      ctx.wire,
      input.ownerAccount,
      input.tier,
      depositor.nativeAddress,
      depositor.publicKey,
      input.wirePublicKey
    )
  }
}
