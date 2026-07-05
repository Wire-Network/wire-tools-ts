import { KeyType } from "@wireio/sdk-core"
import {
  ClusterBuildContext,
  ClusterBuildStep,
  EthereumOutpostBootstrapper,
  KeyGenerator,
  NodeOwnerTier,
  pushNewNamedUser,
  pushNodeOwnerReg,
  Report,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/cluster-tool"

/**
 * Step factories for the `sysio.roa` create-in-flow registration WRITES — the
 * two actions the production depot (`sysio.msgch`) inline-sends when it decodes
 * an inbound OPP NodeOwnerRegistration: {@link planCreateNamedUser}
 * (`roa::newnameduser`, create the account from the claim's Wire key) and
 * {@link planRegisterNodeOwner} (`roa::nodeownreg`, register + inline-record the
 * depositor's ETH link in `sysio.authex`). Each write is its OWN
 * {@link ClusterBuildStep} so the `Report` records it — including the
 * intentionally-bad claims, whose transactions SUCCEED and soft-fail into a
 * `nodeownerreg` audit row that the scenario's verify steps assert.
 */
export namespace NodeOwnerNftScenarioRegistrationSteps {
  /**
   * A new depositor `PUB_EM_*` public key, derived from the run's anvil
   * mnemonic at `ethereumHdIndex` — deterministic, and distinct per claim when
   * each claim carries its own index. A pure value helper: used inside the
   * {@link planRegisterNodeOwner} runner and the scenario's hard-abort probes.
   *
   * @param ctx - The build context (clio / build-path key-generation material).
   * @param ethereumHdIndex - HD account index for the EM derivation.
   * @returns The derived `PUB_EM_*` public key.
   */
  export async function newEthereumPublicKey<C extends ClusterBuildContext>(
    ctx: C,
    ethereumHdIndex: number
  ): Promise<string> {
    const keyContext = KeyGenerator.context(
      ctx.config.executables.clio,
      ctx.config.buildPath,
      EthereumOutpostBootstrapper.AnvilMnemonic
    )
    const pair = await KeyGenerator.create(KeyType.EM, keyContext, { ethereumHdIndex })
    return pair.publicKey
  }

  /** Input for {@link planCreateNamedUser} — one `sysio.roa::newnameduser` write. */
  export interface CreateNamedUserInput extends StepInput {
    readonly kind: "NodeOwnerNftScenarioRegistrationSteps.CreateNamedUserInput"
    /** The vanity account to create (tier-1 names are a 2-6 char prefix). */
    readonly account: string
    /** The holder's Wire owner/active public key (`PUB_K1_*`). */
    readonly wirePublicKey: string
    /** The claim tier the name is validated against. */
    readonly tier: NodeOwnerTier
  }

  /**
   * A single `sysio.roa::newnameduser` write — the create step the depot
   * inline-sends first, making `wirePublicKey` the account's owner/active
   * authority.
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
  export function planCreateNamedUser<C extends ClusterBuildContext = ClusterBuildContext>(
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
        kind: "NodeOwnerNftScenarioRegistrationSteps.CreateNamedUserInput",
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
    await pushNewNamedUser(ctx.wire, input.account, input.wirePublicKey, input.tier)
  }

  /** Input for {@link planRegisterNodeOwner} — one `sysio.roa::nodeownreg` write. */
  export interface RegisterNodeOwnerInput extends StepInput {
    readonly kind: "NodeOwnerNftScenarioRegistrationSteps.RegisterNodeOwnerInput"
    /** The Wire account the claim registers. */
    readonly ownerAccount: string
    /** The claimed tier (1-3 for valid claims). */
    readonly tier: NodeOwnerTier
    /** HD index deriving the claim's new depositor EM key. */
    readonly ethereumHdIndex: number
    /** The claimed owner/active Wire key (an existing account must be controlled by it). */
    readonly wirePublicKey: string
  }

  /**
   * A single `sysio.roa::nodeownreg` write, as the depot inline-sends it.
   * Claim-payload problems (wrong key / invalid name / missing account /
   * replay) soft-fail into a `nodeownerreg` audit row — the transaction
   * SUCCEEDS — so intentionally-bad claims are normal write steps too, with a
   * following verify step asserting the audit outcome. Only the depot/system
   * invariants (tier out of [1,3], non-EM eth key) hard-abort; those are
   * exercised by the scenario's hard-abort verify probes, not by this factory.
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
  export function planRegisterNodeOwner<C extends ClusterBuildContext = ClusterBuildContext>(
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
        kind: "NodeOwnerNftScenarioRegistrationSteps.RegisterNodeOwnerInput",
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
    const ethereumPublicKey = await newEthereumPublicKey(ctx, input.ethereumHdIndex)
    await pushNodeOwnerReg(
      ctx.wire,
      input.ownerAccount,
      input.tier,
      ethereumPublicKey,
      input.wirePublicKey
    )
  }
}
