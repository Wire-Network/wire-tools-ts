import type { ethers } from "ethers"
import type { Keypair } from "@solana/web3.js"
import { outputKey, type OutputKey } from "../OutputStore.js"

/**
 * The paired Ethereum + Solana identity of a swap end-user, carried between
 * Steps via `ctx.outputs`. The swap-user provisioning Steps store one under
 * {@link swapUserOutputKey}; the airdrop Step and downstream swap Steps read it
 * back — the same wallet must appear as the swap `actor`, the reverse-direction
 * `recipient`, and the closing balance assertion.
 */
export interface SwapUserOutput {
  /** Ethereum user wallet — anvil-mnemonic HD wallet past every operator slot. */
  readonly ethereumWallet: ethers.HDNodeWallet
  /** Solana user keypair — signs SPL swaps + is the airdrop recipient. */
  readonly solanaKeypair: Keypair
  /** Raw 20-byte EVM address bytes for the Ethereum wallet. */
  readonly ethereumAddressBytes: Uint8Array
  /** Raw 32-byte ed25519 pubkey bytes for the Solana keypair. */
  readonly solanaPublicKeyBytes: Uint8Array
}

/**
 * Typed cross-step output key for the swap user identity. A flow provisions one
 * swap user, so a single fixed key suffices.
 *
 * @returns A typed `OutputKey<SwapUserOutput>` for `ctx.outputs`.
 */
export function swapUserOutputKey(): OutputKey<SwapUserOutput> {
  return outputKey<SwapUserOutput>("swapUser", "swap end-user identity")
}
