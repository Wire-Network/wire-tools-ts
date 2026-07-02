import Assert from "node:assert"
import { getLogger } from "@wireio/shared"
import { SysioContracts } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import {
  AuthExLinkTool,
  ClusterBuildContext,
  ClusterBuildStep,
  ethereumPrivateKeyFromWallet,
  provisionWireUser,
  Report,
  type ClusterBuildStepOptions,
  type ImportSeedChainKind,
  type StepInput
} from "@wireio/test-cluster-tool"
import { EmissionsSoakScenarioConstants as Constants } from "../EmissionsSoakScenarioConstants.js"
import {
  ClaimantIdentitiesKey,
  EthereumSeedConversionKey,
  SolanaSeedConversionKey,
  type SeedConversionSummary
} from "../EmissionsSoakScenarioOutputs.js"
import {
  controlledStakerWallet,
  type ControlledStakerIdentity
} from "../EmissionsSoakScenarioSyntheticDump.js"

const log = getLogger(__filename)

const { SysioContractAccount, SysioContractName } = SysioContracts

/** `sysio.authex@active` — `linkswept` is an AUTHEX-authed sweep, mirroring the launch orchestrator. */
const AuthexActiveAuthorization = [
  { actor: SysioContractAccount[SysioContractName.authex], permission: "active" }
]

/**
 * Flow-local step factories for the emissions soak: dclaim seeding
 * (importseed / importdone), claimer provisioning (account + authex link +
 * linkswept sweep), the per-staker claim, and the kiod wallet unlock the old
 * suite performed before each write burst.
 */
export namespace EmissionsSoakScenarioSteps {
  // ── unlock the kiod wallet (client-side session state, idempotent) ────────

  /**
   * Open + unlock the cluster wallet. The old suite ran `walletOpenAndUnlock`
   * before the import and claim bursts — kiod auto-locks after its unlock
   * timeout, which the 30-minute soak window always exceeds.
   */
  export function unlockWallet<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runUnlockWallet)
  }

  /** Named runner — open + unlock the default kiod wallet. */
  export async function runUnlockWallet<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.wallet.unlock()
  }

  // ── publish the build-time seed data into ctx.outputs ─────────────────────

  /** Input for {@link publishSeedData} — the build-time-generated seed corpus. */
  export interface PublishSeedDataInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.PublishSeedDataInput"
    readonly identities: ControlledStakerIdentity[]
    readonly ethereum: SeedConversionSummary
    readonly solana: SeedConversionSummary
  }

  /**
   * Publish the controlled-staker roster + both chains' importseed conversions
   * into `ctx.outputs` (the cross-step channel every import/claimer/verify
   * step reads), logging the conversion stats the old suite logged.
   */
  export function publishSeedData<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    identities: ControlledStakerIdentity[],
    ethereum: SeedConversionSummary,
    solana: SeedConversionSummary
  ): ClusterBuildStep<C, PublishSeedDataInput> {
    return ClusterBuildStep.create<C, PublishSeedDataInput>(
      actor,
      name,
      description,
      options,
      { kind: "EmissionsSoakScenarioSteps.PublishSeedDataInput", identities, ethereum, solana },
      runPublishSeedData
    )
  }

  /** Named runner — store the outputs + log the conversion header. */
  export async function runPublishSeedData<C extends ClusterBuildContext>(
    ctx: C,
    input: PublishSeedDataInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    ctx.outputs
      .set(ClaimantIdentitiesKey, input.identities)
      .set(EthereumSeedConversionKey, input.ethereum)
      .set(SolanaSeedConversionKey, input.solana)
    log.info(
      `[soak] controlled=${input.identities.length} (seed=${Constants.SyntheticSeed}) ` +
        `ETH conversion: ${input.ethereum.uniqueAddresses} unique, ` +
        `${input.ethereum.nonZeroCredits} credits, ${input.ethereum.batches.length} batches, ` +
        `${input.ethereum.totalAtomic} atomic total, dust=${input.ethereum.droppedDust}`
    )
    log.info(
      `[soak] SOL conversion: ${input.solana.uniqueAddresses} unique, ` +
        `${input.solana.nonZeroCredits} credits, ${input.solana.batches.length} batches, ` +
        `${input.solana.totalAtomic} atomic total, dust=${input.solana.droppedDust}`
    )
  }

  // ── push ONE importseed batch (one write per step) ─────────────────────────

  /** Input for {@link importSeedBatch} — names the batch; the payload rides `ctx.outputs`. */
  export interface ImportSeedBatchInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.ImportSeedBatchInput"
    readonly chain: ImportSeedChainKind
    readonly batchIndex: number
    readonly creditCount: number
  }

  /** `sysio.dclaim::importseed` — push ONE converted batch (dclaim self-auth). */
  export function importSeedBatch<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: ImportSeedChainKind,
    batchIndex: number,
    creditCount: number
  ): ClusterBuildStep<C, ImportSeedBatchInput> {
    return ClusterBuildStep.create<C, ImportSeedBatchInput>(
      actor,
      name,
      description,
      options,
      { kind: "EmissionsSoakScenarioSteps.ImportSeedBatchInput", chain, batchIndex, creditCount },
      runImportSeedBatch
    )
  }

  /** Named runner — resolve the batch from `ctx.outputs`, push `importseed`. */
  export async function runImportSeedBatch<C extends ClusterBuildContext>(
    ctx: C,
    input: ImportSeedBatchInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    // Two-variant union → single-guard conditional (STYLE: don't match two branches).
    const summary = ctx.outputs.assert(
        input.chain === Constants.EthereumChain ? EthereumSeedConversionKey : SolanaSeedConversionKey
      ),
      batch = summary.batches[input.batchIndex]
    Assert.ok(batch != null, `importseed batch ${input.batchIndex} missing for ${input.chain}`)
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.importseed.invoke(batch)
  }

  // ── close the import window ────────────────────────────────────────────────

  /** `sysio.dclaim::importdone` — flip `cap_config.imported_complete` (dclaim self-auth). */
  export function importDone<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runImportDone)
  }

  /** Named runner — `sysio.dclaim::importdone` (empty payload). */
  export async function runImportDone<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.getSysioContract(SysioContractName.dclaim).actions.importdone.invoke({})
  }

  // ── provision a claimer's WIRE account ─────────────────────────────────────

  /** Input for {@link provisionClaimer}. */
  export interface ProvisionClaimerInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.ProvisionClaimerInput"
    readonly wireAccount: string
  }

  /**
   * Provision a controlled staker's WIRE account under the dev K1 key with the
   * standard resource policy (the account must host its authex link + pclaim
   * row) — the harness's ONE user-provisioning mechanism, unfunded.
   */
  export function provisionClaimer<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    wireAccount: string
  ): ClusterBuildStep<C, ProvisionClaimerInput> {
    return ClusterBuildStep.create<C, ProvisionClaimerInput>(
      actor,
      name,
      description,
      options,
      { kind: "EmissionsSoakScenarioSteps.ProvisionClaimerInput", wireAccount },
      runProvisionClaimer
    )
  }

  /** Named runner — `provisionWireUser` (create account + resource policy). */
  export async function runProvisionClaimer<C extends ClusterBuildContext>(
    ctx: C,
    input: ProvisionClaimerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await provisionWireUser(ctx.wire, input.wireAccount)
  }

  // ── authex-link a claimer's ETH wallet ─────────────────────────────────────

  /** Input for {@link authexLink} — the staker identity (wallet re-derived from the HD index). */
  export interface AuthexLinkInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.AuthexLinkInput"
    readonly identity: ControlledStakerIdentity
  }

  /**
   * `sysio.authex::createlink` — link the staker's ETH wallet to its WIRE
   * account. The EM key identifies which ETH wallet "owns" the account; the
   * account still signs with the dev K1 key.
   */
  export function authexLink<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    identity: ControlledStakerIdentity
  ): ClusterBuildStep<C, AuthexLinkInput> {
    return ClusterBuildStep.create<C, AuthexLinkInput>(
      actor,
      name,
      description,
      options,
      { kind: "EmissionsSoakScenarioSteps.AuthexLinkInput", identity },
      runAuthexLink
    )
  }

  /** Named runner — re-derive the wallet, push the authex link. */
  export async function runAuthexLink<C extends ClusterBuildContext>(
    ctx: C,
    input: AuthexLinkInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const wallet = controlledStakerWallet(input.identity)
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: ChainKind.EVM,
      account: input.identity.wireAccount,
      privateKey: ethereumPrivateKeyFromWallet(wallet),
      ethereumWallet: wallet
    })
  }

  // ── sweep the staker's unmapped credit into pending_claims ────────────────

  /** Input for {@link linkswept}. */
  export interface LinksweptInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.LinksweptInput"
    readonly wireAccount: string
    /**
     * The exact bytes `importseed` stored for this staker — the 20-byte ETH
     * address as lower-case hex (NOT the 33-byte compressed pubkey); linkswept
     * matches on raw byte equality.
     */
    readonly nativePubkeyHex: string
  }

  /**
   * `sysio.dclaim::linkswept` — sweep the staker's `unmapped_tokens` row into
   * `pending_claims`. `createlink` does NOT auto-sweep; in a real launch an
   * off-chain orchestrator batches one sweep per new link — mirrored here.
   */
  export function linkswept<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    wireAccount: string,
    nativePubkeyHex: string
  ): ClusterBuildStep<C, LinksweptInput> {
    return ClusterBuildStep.create<C, LinksweptInput>(
      actor,
      name,
      description,
      options,
      { kind: "EmissionsSoakScenarioSteps.LinksweptInput", wireAccount, nativePubkeyHex },
      runLinkswept
    )
  }

  /** Named runner — `sysio.dclaim::linkswept`, AUTHEX-authed. */
  export async function runLinkswept<C extends ClusterBuildContext>(
    ctx: C,
    input: LinksweptInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.getSysioContract(SysioContractName.dclaim).actions.linkswept.invoke(
      {
        wire_account: input.wireAccount,
        // Same wire-format NAME spelling the previously-green suite pushed.
        chain: Constants.EthereumChain,
        native_pubkey: input.nativePubkeyHex
      },
      { authorization: AuthexActiveAuthorization }
    )
  }

  // ── claim the staker's pending balance ─────────────────────────────────────

  /** Input for {@link claim}. */
  export interface ClaimInput extends StepInput {
    readonly kind: "EmissionsSoakScenarioSteps.ClaimInput"
    readonly wireAccount: string
  }

  /** `sysio.dclaim::claim` — drain the staker's pclaim row into WIRE (staker-authed). */
  export function claim<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    wireAccount: string
  ): ClusterBuildStep<C, ClaimInput> {
    return ClusterBuildStep.create<C, ClaimInput>(
      actor,
      name,
      description,
      options,
      { kind: "EmissionsSoakScenarioSteps.ClaimInput", wireAccount },
      runClaim
    )
  }

  /** Named runner — `sysio.dclaim::claim` authorized by the staker. */
  export async function runClaim<C extends ClusterBuildContext>(
    ctx: C,
    input: ClaimInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.claim.invoke(
        { wire_account: input.wireAccount },
        { authorization: [{ actor: input.wireAccount, permission: "active" }] }
      )
  }
}
