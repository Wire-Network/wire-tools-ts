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
 * Per the orchestration model, {@link ensure} RETURNS a {@link ClusterBuildPhase}:
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
import { swapUserOutputKey } from "../../orchestration/outputs/SwapUserOutput.js"
import { EthereumOutpostBootstrapper } from "../../orchestration/ethereum/EthereumOutpostBootstrapper.js"
import { Report } from "../../report/Report.js"

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
   */
  export function ensure<C extends ClusterBuildContext = ClusterBuildContext>(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number = DefaultEthereumHdIndex,
    airdropFloorLamports: number = DefaultSolanaAirdropFloorLamports
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(parent, name, description, [
      provisionIdentity<C>(
        Report.Actor.User,
        "swap-user-identity",
        "generate the swap user's ETH + SOL identity",
        options,
        ethereumHdIndex
      ),
      airdrop<C>(
        Report.Actor.User,
        "swap-user-airdrop",
        "airdrop SOL to the swap user",
        options,
        airdropFloorLamports
      )
    ])
  }

  // ── Step: provision identity (setup — generate + store the output) ───────

  /** Input for {@link provisionIdentity}. */
  export interface ProvisionIdentityInput extends StepInput {
    readonly kind: "SwapUserIdentities.ProvisionIdentityInput"
    readonly ethereumHdIndex: number
  }

  /** Derive the swap user's ETH wallet + SOL keypair and store a {@link SwapUserOutput}. */
  export function provisionIdentity<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number
  ): ClusterBuildStep<C, ProvisionIdentityInput> {
    return ClusterBuildStep.create<C, ProvisionIdentityInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapUserIdentities.ProvisionIdentityInput", ethereumHdIndex },
      runProvisionIdentity
    )
  }

  /** Named runner — derive keys, store the {@link SwapUserOutput}. */
  export async function runProvisionIdentity<C extends ClusterBuildContext>(
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
    ctx.outputs.set(swapUserOutputKey(), {
      ethereumWallet,
      solanaKeypair,
      ethereumAddressBytes: ethers.getBytes(ethereumWallet.address),
      solanaPublicKeyBytes: solanaKeypair.publicKey.toBytes()
    })
    log.info(
      `[swap-user] ETH ${ethereumWallet.address} (hd=${input.ethereumHdIndex}), SOL ${solanaKeypair.publicKey.toBase58()}`
    )
  }

  // ── Step: airdrop SOL to the swap user (write) ───────────────────────────

  /** Input for {@link airdrop}. */
  export interface AirdropInput extends StepInput {
    readonly kind: "SwapUserIdentities.AirdropInput"
    readonly floorLamports: number
  }

  /** Airdrop SOL to the swap user when the balance is below `floorLamports`. */
  export function airdrop<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    floorLamports: number
  ): ClusterBuildStep<C, AirdropInput> {
    return ClusterBuildStep.create<C, AirdropInput>(
      actor,
      name,
      description,
      options,
      { kind: "SwapUserIdentities.AirdropInput", floorLamports },
      runAirdrop
    )
  }

  /** Named runner — read the balance (a read), then ONE `requestAirdrop` if below floor. */
  export async function runAirdrop<C extends ClusterBuildContext>(
    ctx: C,
    input: AirdropInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const swapUser = ctx.outputs.assert(swapUserOutputKey())
    const publicKey = swapUser.solanaKeypair.publicKey
    const current = await ctx.solana.getLamports(publicKey)
    if (current >= input.floorLamports) return
    const requestLamports = input.floorLamports - current + LAMPORTS_PER_SOL
    const signature = await ctx.solana.connection.requestAirdrop(publicKey, requestLamports)
    await confirmSignature(
      ctx.solana.connection,
      signature,
      `swap-user airdrop to ${publicKey.toBase58()}`
    )
  }
}
