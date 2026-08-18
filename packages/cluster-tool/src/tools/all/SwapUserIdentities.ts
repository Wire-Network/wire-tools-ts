/**
 * SwapUserIdentities — orchestration-unit factory that provisions a paired
 * Ethereum + Solana swap end-user identity for the swap flows
 * (flow-swap-with-underwriting / -non-native-tokens / -variance-revert).
 *
 * The bootstrap operator keypairs are bound to the operator roster; reusing one
 * for a user-initiated swap would conflate operator identity with end-user
 * identity in the depot's authex resolution, so swap flows provision their own
 * user here.
 *
 * Per the orchestration model, {@link planIdentityProvisioning} RETURNS a {@link ClusterBuildPhase}:
 * a `provision-identity` setup Step (derive the ETH wallet + SOL keypair, store a
 * {@link SwapUserOutput}) followed by an `airdrop` write Step. Cross-step values
 * ride `ctx.outputs`; identity derivation is a pure value helper inside the runner.
 */

import { ethers } from "ethers"
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js"
import { getLogger } from "@wireio/shared"
import { confirmSignature } from "../../clients/solana/utils/signatureUtils.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { ClusterBuildPhase } from "../../orchestration/ClusterBuildPhase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { ClusterBuildParent } from "../../orchestration/ClusterBuildPhaseBase.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import {
  SwapUserOutput,
  swapUserOutputKey
} from "../../orchestration/outputs/SwapUserOutput.js"
import { EthereumOutpostBootstrapper } from "../../orchestration/ethereum/EthereumOutpostBootstrapper.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"

const log = getLogger(__filename)

export namespace SwapUserIdentities {
  /** HD index past every operator slot in the largest planned cluster. */
  export const DefaultEthereumHdIndex = 32
  /** Airdrop floor — 100 SOL covers the largest swap source amount + headroom. */
  export const DefaultSolanaAirdropFloorLamports = 100 * LAMPORTS_PER_SOL

  // ── Composite: provision the swap user (RETURNS a Phase of Steps) ────────

  /**
   * Build the swap-user provisioning Phase: derive identity → airdrop SOL. The
   * identity lands in `ctx.outputs` under {@link swapUserOutputKey} for the swap
   * Steps to read.
   *
   * @param parent Build parent receiving the provisioning phase.
   * @param name Stable phase name.
   * @param description Human-readable phase description.
   * @param options Step execution options.
   * @param ethereumHdIndex Deterministic Anvil wallet index.
   * @param airdropFloorLamports Required Solana balance floor.
   * @param actorIndex Zero-based swap-user output index.
   * @returns Registered identity-provisioning phase.
   */
  export function planIdentityProvisioning<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number = DefaultEthereumHdIndex,
    airdropFloorLamports: number = DefaultSolanaAirdropFloorLamports,
    actorIndex: number = SwapUserOutput.DefaultActorIndex
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(parent, name, description, [
      planIdentityCreation<C>(
        Report.Actor.User,
        "swap-user-identity",
        "generate the swap user's ETH + SOL identity",
        options,
        ethereumHdIndex,
        actorIndex
      ),
      planAirdrop<C>(
        Report.Actor.User,
        "swap-user-airdrop",
        "airdrop SOL to the swap user",
        options,
        airdropFloorLamports,
        actorIndex
      )
    ])
  }

  // ── Step: provision identity (setup — generate + store the output) ───────

  /** Input for {@link planIdentityCreation}. */
  export interface ProvisionIdentityInput extends StepInput {
    readonly kind: "SwapUserIdentities.ProvisionIdentityInput"
    /** Deterministic Anvil wallet index. */
    readonly ethereumHdIndex: number
    /** Zero-based swap-user output index. */
    readonly actorIndex: number
  }

  /**
   * Plan identity derivation for one indexed swap user.
   *
   * @param actor Report actor responsible for the step.
   * @param name Stable step name.
   * @param description Human-readable step description.
   * @param options Step execution options.
   * @param ethereumHdIndex Deterministic Anvil wallet index.
   * @param actorIndex Zero-based swap-user output index.
   * @returns Identity-creation step.
   */
  export function planIdentityCreation<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number,
    actorIndex: number = SwapUserOutput.DefaultActorIndex
  ): ClusterBuildStep<C, ProvisionIdentityInput> {
    return ClusterBuildStep.create<C, ProvisionIdentityInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapUserIdentities.ProvisionIdentityInput",
        ethereumHdIndex,
        actorIndex
      },
      runIdentityCreation
    )
  }

  /**
   * Derive keys and store the indexed {@link SwapUserOutput}.
   *
   * @param ctx Cluster build context.
   * @param input Indexed identity input.
   * @param signal Cooperative cancellation signal.
   * @returns A promise resolved after the identity is recorded.
   */
  export async function runIdentityCreation<C extends ClusterBuildContext>(
    ctx: C,
    input: ProvisionIdentityInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const ethereumWallet = ethers.HDNodeWallet.fromMnemonic(
      ethers.Mnemonic.fromPhrase(EthereumOutpostBootstrapper.AnvilMnemonic),
      `${EthereumOutpostBootstrapper.DerivationPath}${input.ethereumHdIndex}`
    ).connect(ctx.ethereum.provider)
    const solanaKeypair = Keypair.generate()
    StepExtraRecorder.record({
      client: "ethers",
      kind: "keygen",
      purpose: "swap user — ethereum wallet (EM, anvil HD derivation)",
      derivation: `${EthereumOutpostBootstrapper.DerivationPath}${input.ethereumHdIndex}`,
      keyPair: {
        type: "EM",
        address: ethereumWallet.address,
        publicKey: ethereumWallet.publicKey,
        privateKey: ethereumWallet.privateKey
      }
    })
    StepExtraRecorder.record({
      client: "solana-web3",
      kind: "keygen",
      purpose: "swap user — solana keypair (ED)",
      keyPair: {
        type: "ED",
        publicKey: solanaKeypair.publicKey.toBase58(),
        secretKeyBase64: Buffer.from(solanaKeypair.secretKey).toString("base64")
      }
    })
    ctx.outputs.set(swapUserOutputKey(input.actorIndex), {
      ethereumWallet,
      solanaKeypair,
      ethereumAddressBytes: ethers.getBytes(ethereumWallet.address),
      solanaPublicKeyBytes: solanaKeypair.publicKey.toBytes()
    })
    log.info(
      `[swap-user:${input.actorIndex}] ETH ${ethereumWallet.address} (hd=${input.ethereumHdIndex}), SOL ${solanaKeypair.publicKey.toBase58()}`
    )
  }

  // ── Step: airdrop SOL to the swap user (write) ───────────────────────────

  /** Input for {@link planAirdrop}. */
  export interface AirdropInput extends StepInput {
    readonly kind: "SwapUserIdentities.AirdropInput"
    /** Required Solana balance floor. */
    readonly floorLamports: number
    /** Zero-based swap-user output index. */
    readonly actorIndex: number
  }

  /**
   * Plan a SOL airdrop for one indexed swap user.
   *
   * @param actor Report actor responsible for the step.
   * @param name Stable step name.
   * @param description Human-readable step description.
   * @param options Step execution options.
   * @param floorLamports Required Solana balance floor.
   * @param actorIndex Zero-based swap-user output index.
   * @returns Solana airdrop step.
   */
  export function planAirdrop<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    floorLamports: number,
    actorIndex: number = SwapUserOutput.DefaultActorIndex
  ): ClusterBuildStep<C, AirdropInput> {
    return ClusterBuildStep.create<C, AirdropInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "SwapUserIdentities.AirdropInput",
        floorLamports,
        actorIndex
      },
      runAirdrop
    )
  }

  /**
   * Read the indexed user's balance, then request one airdrop when below floor.
   *
   * @param ctx Cluster build context.
   * @param input Indexed airdrop input.
   * @param signal Cooperative cancellation signal.
   * @returns A promise resolved after the balance reaches the requested floor.
   */
  export async function runAirdrop<C extends ClusterBuildContext>(
    ctx: C,
    input: AirdropInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey(input.actorIndex))
    const publicKey = swapUser.solanaKeypair.publicKey
    const current = await ctx.solana.getLamports(publicKey)
    if (current >= input.floorLamports) return
    const requestLamports = input.floorLamports - current + LAMPORTS_PER_SOL
    const signature = await ctx.solana.connection.requestAirdrop(
      publicKey,
      requestLamports
    )
    await confirmSignature(
      ctx.solana.connection,
      signature,
      `swap-user airdrop to ${publicKey.toBase58()}`
    )
  }
}
