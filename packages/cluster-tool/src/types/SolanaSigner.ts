import type { AnchorProvider } from "@coral-xyz/anchor"
import type { PublicKey } from "@solana/web3.js"

/**
 * Anchor's provider-wallet contract — DERIVED from `AnchorProvider`'s own
 * constructor parameter (`signTransaction` / `signAllTransactions` /
 * `publicKey`), never re-spelled, so a {@link SolanaSigner} is exactly what an
 * `AnchorProvider` wraps.
 */
export type AnchorWallet = ConstructorParameters<typeof AnchorProvider>[1]

/**
 * THE harness's Solana signer — the ONE shape over both custody forms of an
 * ED key (`keyPairUtils.solanaSigner`): local material (a web3 `Keypair`,
 * `keyPairUtils.solanaSignerFromKeypair`) or an AWS KMS
 * `ECC_NIST_EDWARDS25519` key whose every signature is a remote `KMS::Sign`
 * (`KMSClientProvider.createSolanaSigner`). It is an {@link AnchorWallet}, so
 * it signs transactions through an `AnchorProvider` exactly like a keypair
 * wallet, and it additionally signs RAW messages — the authex link proof —
 * with pure Ed25519 (RFC 8032), the algorithm Solana transactions use.
 */
export interface SolanaSigner extends AnchorWallet {
  /** The signer's public key — the fee payer every transaction it signs is set to. */
  readonly publicKey: PublicKey
  /**
   * Sign `message` with pure Ed25519 — the raw bytes, no digest: 1 to 4096
   * bytes, the KMS `MessageType.RAW` limit every custody form observes.
   *
   * @param message - The bytes to sign.
   * @returns The 64-byte detached signature.
   */
  signMessage(message: Uint8Array): Promise<Uint8Array>
}
