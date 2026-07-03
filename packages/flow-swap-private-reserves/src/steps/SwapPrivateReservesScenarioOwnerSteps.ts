import { Bytes, KeyType, PrivateKey } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import {
  AuthExLinkTool,
  ClusterBuildStep,
  Report,
  SolanaFundingTool,
  ethereumPrivateKeyFromWallet,
  provisionWireUser,
  swapUserOutputKey,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type StepInput
} from "@wireio/test-cluster-tool"
import { SwapPrivateReservesScenarioArtifacts as Artifacts } from "../SwapPrivateReservesScenarioArtifacts.js"
import { SwapPrivateReservesScenarioConstants as Constants } from "../SwapPrivateReservesScenarioConstants.js"

/**
 * Owner-provisioning write Steps: the single WIRE account (`privowner`) that
 * matches — and therefore owns — BOTH private reserves, its authex links on
 * BOTH chains (each link key must equal the matching reserve's creator key for
 * `matchreserve` to admit it), and the creator-side USDCSOL funding for the
 * SOL escrow + Phase B source.
 */
export namespace SwapPrivateReservesScenarioOwnerSteps {
  // ── Step: provision the owner WIRE account (writes) ──────────────────────

  /** Input for {@link planProvisionOwner}. */
  export interface ProvisionOwnerInput extends StepInput {
    readonly kind: "SwapPrivateReservesScenarioOwnerSteps.ProvisionOwnerInput"
    /** The owner WIRE account name. */
    readonly account: string
    /** Raw 9-dec WIRE funding (covers both real-WIRE match escrows). */
    readonly fundWireAmount: bigint
  }

  /**
   * Provision the owner WIRE account — create it under the dev key, attach the
   * standard resource policy, and fund it with enough WIRE to escrow both
   * `matchreserve` amounts (via the harness's `provisionWireUser`).
   */
  export function planProvisionOwner<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, ProvisionOwnerInput> {
    return ClusterBuildStep.create<C, ProvisionOwnerInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapPrivateReservesScenarioOwnerSteps.ProvisionOwnerInput",
        account: Constants.Accounts.Owner,
        fundWireAmount: Constants.Accounts.OwnerFunding
      },
      runProvisionOwner
    )
  }

  /** Named runner — account create + resource policy + WIRE funding. */
  export async function runProvisionOwner<C extends ClusterBuildContext>(
    ctx: C,
    input: ProvisionOwnerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await provisionWireUser(ctx.wire, input.account, {
      fundWireAmount: input.fundWireAmount
    })
  }

  // ── Step: authex-link the owner to a creator chain key (write) ───────────

  /** Input for {@link planLinkOwner}. */
  export interface LinkOwnerInput extends StepInput {
    readonly kind: "SwapPrivateReservesScenarioOwnerSteps.LinkOwnerInput"
    /** The owner WIRE account name. */
    readonly account: string
    /** The chain family whose creator key the owner links to. */
    readonly chainKind: ChainKind
  }

  /**
   * A single `sysio.authex::createlink` write binding the owner to the swap
   * user's key on one chain (EVM: the ETH creator wallet's secp256k1 key;
   * SVM: the SOL creator keypair's ed25519 key). `matchreserve` gates on the
   * matcher's link key for the reserve's chain equalling the creator key, so
   * BOTH links are required before either match.
   */
  export function planLinkOwner<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chainKind: ChainKind
  ): ClusterBuildStep<C, LinkOwnerInput> {
    return ClusterBuildStep.create<C, LinkOwnerInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapPrivateReservesScenarioOwnerSteps.LinkOwnerInput",
        account: Constants.Accounts.Owner,
        chainKind
      },
      runLinkOwner
    )
  }

  /**
   * Named runner — ONE `createlink` write for the owner on `input.chainKind`
   * (same EVM-first / SVM-passthrough shape as the palette's own
   * `WireOperatorProvisioningTool.runAuthexLink`, keyed to the swap user's
   * live wallet/keypair instead of a stored operator).
   */
  export async function runLinkOwner<C extends ClusterBuildContext>(
    ctx: C,
    input: LinkOwnerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    if (input.chainKind === ChainKind.EVM) {
      await AuthExLinkTool.createLink(ctx.wire, {
        chainKind: ChainKind.EVM,
        account: input.account,
        privateKey: ethereumPrivateKeyFromWallet(swapUser.ethereumWallet),
        ethereumWallet: swapUser.ethereumWallet
      })
      return
    }
    // WIRE PrivateKey<ED> stores the full 64-byte secretKey (seed + pubkey
    // concat — the same shape as `Keypair.secretKey`), so the SVM link
    // regenerates from the keypair's full secret verbatim.
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: input.chainKind,
      account: input.account,
      privateKey: PrivateKey.regenerate(
        KeyType.ED,
        Bytes.fromString(
          Buffer.from(swapUser.solanaKeypair.secretKey).toString("hex"),
          "hex"
        )
      )
    })
  }

  // ── Step: fund the creator's USDCSOL ATA (write) ─────────────────────────

  /** Input for {@link planMintCreatorUsdcSol}. */
  export interface MintCreatorUsdcSolInput extends StepInput {
    readonly kind: "SwapPrivateReservesScenarioOwnerSteps.MintCreatorUsdcSolInput"
    /** USDCSOL base units minted into the creator's ATA. */
    readonly amount: bigint
  }

  /**
   * A single mock-SPL mint into the SOL creator's ATA (create escrow +
   * Phase B source + headroom), signed by the persisted deployer keypair
   * (the mint authority).
   */
  export function planMintCreatorUsdcSol<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, MintCreatorUsdcSolInput> {
    return ClusterBuildStep.create<C, MintCreatorUsdcSolInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapPrivateReservesScenarioOwnerSteps.MintCreatorUsdcSolInput",
        amount: Constants.SplFunding.CreatorMintAmount
      },
      runMintCreatorUsdcSol
    )
  }

  /** Named runner — ONE `mintMockSplToUser` into the swap user's USDCSOL ATA. */
  export async function runMintCreatorUsdcSol<C extends ClusterBuildContext>(
    ctx: C,
    input: MintCreatorUsdcSolInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    await SolanaFundingTool.mintMockSplToUser(
      ctx.solana.connection,
      SolanaFundingTool.loadDeployerKeypair(ctx.config.dataPath),
      Artifacts.loadUsdcSolMint(ctx),
      swapUser.solanaKeypair.publicKey,
      input.amount
    )
  }
}
