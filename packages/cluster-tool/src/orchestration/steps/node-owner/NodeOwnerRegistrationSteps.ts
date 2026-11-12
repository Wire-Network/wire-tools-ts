import { KeyType, SysioContracts } from "@wireio/sdk-core"
import { KeyGenerator } from "../../../clients/wire/KeyGenerator.js"
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
import { KeySteps } from "../KeySteps.js"

const { SysioAuthexChainkind, SysioContractName } = SysioContracts

/**
 * Registration writes for fresh claims and pre-existing-account rejection fixtures.
 * Each write is its own Step; nodeownreg owns atomic creation, registration and linkage.
 * Claim rejections commit an audit row and are checked by the following verify step.
 *
 * Before a governance handoff `sysio.roa@active` is the bootstrap `sysio` key,
 * so these writes stand in for the depot's dispatch; after one, an owner claims
 * through the OPP path ({@link NodeOwnerCommitSteps}).
 */
export namespace NodeOwnerRegistrationSteps {
  /**
   * A new depositor `PUB_EM_*` public key, derived from the run's Ethereum
   * mnemonic (`KeySteps.keyGeneratorContext`) at `ethereumHdIndex` —
   * deterministic, and distinct per claim when each claim carries its own
   * index. A pure value helper: used inside the {@link planRegisterNodeOwner}
   * runner and the scenario's hard-abort probes.
   *
   * @param ctx - The build context (the run's key-generation material).
   * @param ethereumHdIndex - HD account index for the EM derivation.
   * @returns The derived `PUB_EM_*` public key.
   */
  export async function newEthereumPublicKey<C extends ClusterBuildContext>(
    ctx: C,
    ethereumHdIndex: number
  ): Promise<string> {
    return (await newEthereumIdentity(ctx, ethereumHdIndex)).publicKey
  }

  /** Deterministic depositor EM identity, including the raw address required by nodeownreg. */
  export async function newEthereumIdentity<C extends ClusterBuildContext>(
    ctx: C,
    ethereumHdIndex: number
  ): Promise<EthereumIdentity> {
    const pair = await KeyGenerator.create(KeyType.EM, KeySteps.keyGeneratorContext(ctx), {
      ethereumHdIndex
    })
    return {
      publicKey: pair.publicKey,
      nativeAddress: pair.address.slice(2).toLowerCase()
    }
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

  /** Input for the privileged pre-existing Ethereum link fixture. */
  interface AuthexLinkInput extends StepInput {
    readonly kind: "NodeOwnerRegistrationSteps.AuthexLinkInput"
    readonly account: string
    readonly ethereumHdIndex: number
  }

  /**
   * Record a fixture account's Ethereum identity before testing a rejected claim.
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Per-step tuning.
   * @param account - Existing fixture account.
   * @param ethereumHdIndex - HD index for the fixture link, distinct from the claim's.
   * @returns The link fixture step.
   */
  export function planAuthexLink<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    ethereumHdIndex: number
  ): ClusterBuildStep<C, AuthexLinkInput> {
    return ClusterBuildStep.create<C, AuthexLinkInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "NodeOwnerRegistrationSteps.AuthexLinkInput",
        account,
        ethereumHdIndex
      },
      runAuthexLink
    )
  }

  async function runAuthexLink<C extends ClusterBuildContext>(
    ctx: C,
    input: AuthexLinkInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { publicKey, nativeAddress } = await newEthereumIdentity(
      ctx,
      input.ethereumHdIndex
    )
    await ctx.wire
      .getSysioContract(SysioContractName.authex)
      .actions.recordlink.invoke({
        account: input.account,
        chain_kind: SysioAuthexChainkind.CHAIN_KIND_EVM,
        pub_key: publicKey,
        native_address: nativeAddress
      })
  }

  /** Input for {@link planRegisterNodeOwner} — one `sysio.roa::nodeownreg` write. */
  export interface RegisterNodeOwnerInput extends StepInput {
    readonly kind: "NodeOwnerRegistrationSteps.RegisterNodeOwnerInput"
    /** The Wire account the claim registers. */
    readonly ownerAccount: string
    /** The claimed tier (1-3 for valid claims). */
    readonly tier: NodeOwnerTier
    /** HD index deriving the claim's new depositor EM key. */
    readonly ethereumHdIndex: number
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
   * coverage exercises address length because this factory derives a valid
   * Ethereum address.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Per-step tuning.
   * @param ownerAccount - The Wire account the claim registers.
   * @param tier - The claimed tier.
   * @param ethereumHdIndex - HD index deriving the claim's new depositor EM key.
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
    ethereumHdIndex: number,
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
        ethereumHdIndex,
        wirePublicKey
      },
      runRegisterNodeOwner
    )
  }

  /** Named runner — derive the claim's new EM key, then ONE `sysio.roa::nodeownreg` write. */
  export async function runRegisterNodeOwner<C extends ClusterBuildContext>(
    ctx: C,
    input: RegisterNodeOwnerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const ethereumIdentity = await newEthereumIdentity(
      ctx,
      input.ethereumHdIndex
    )
    await pushNodeOwnerReg(
      ctx.wire,
      input.ownerAccount,
      input.tier,
      ethereumIdentity.nativeAddress,
      ethereumIdentity.publicKey,
      input.wirePublicKey
    )
  }
}
