import { ethers } from "ethers"
import { Keypair } from "@solana/web3.js"
import {
  Bytes,
  getCompressedPublicKey,
  KeyType,
  PrivateKey,
  PublicKey
} from "@wireio/sdk-core"
import type { EthereumKeyPair, SolanaKeyPair } from "../types/KeyPair.js"

/**
 * Derivations between the strongly-typed KeyPair structures and the live chain-SDK
 * objects — BOTH directions. The typed pairs are the stored, JSON-round-trippable
 * form (in `ClusterKeyStore` / operator outputs); these helpers (a) reconstruct the
 * ephemeral ethers/web3 signing objects from a stored pair, and (b) build a stored
 * pair from a live ethers wallet. This is DERIVATION only — key GENERATION is the
 * separate concern owned by `KeyGenerator` (see `one-generic-facade-per-concept`).
 */

// ── stored EthereumKeyPair → live objects ───────────────────────────────────

/** The raw 0x-hex secp256k1 private key underlying an EM key pair. */
function ethereumPrivateKeyHex(ethereum: EthereumKeyPair): string {
  return ethers.hexlify(PrivateKey.from(ethereum.privateKey).data.array)
}

/** An ethers signer (connected to `provider`) reconstructed from an EM key pair. */
export function ethereumSigner(
  ethereum: EthereumKeyPair,
  provider: ethers.Provider
): ethers.Wallet {
  return new ethers.Wallet(ethereumPrivateKeyHex(ethereum), provider)
}

/**
 * The 33-byte compressed secp256k1 public key (the depot `opAddress`) from an EM
 * key pair — derived from the private key so it agrees with the signer.
 */
export function ethereumCompressedPubkey(ethereum: EthereumKeyPair): Uint8Array {
  const signingKey = new ethers.SigningKey(ethereumPrivateKeyHex(ethereum))
  return ethers.getBytes(ethers.SigningKey.computePublicKey(signingKey.publicKey, true))
}

/** The sdk-core EM PrivateKey from an EM key pair (native `0x…` via `toNativeString`). */
export function ethereumSdkPrivateKey(ethereum: EthereumKeyPair): PrivateKey {
  return PrivateKey.from(ethereum.privateKey)
}

/**
 * The 64-byte uncompressed secp256k1 public key as `0x` + 128 hex chars — the
 * nodeop ethereum signature-provider public-key format (the `04` uncompressed
 * marker is stripped to match the C++ fixture format).
 */
export function ethereumUncompressedPublicKeyHex(ethereum: EthereumKeyPair): string {
  const signingKey = new ethers.SigningKey(ethereumPrivateKeyHex(ethereum))
  return `0x${signingKey.publicKey.slice(4)}`
}

// ── live ethers wallet → typed keys (used by KeyGenerator + authex signing) ──

/** The WIRE `PVT_EM_*` secp256k1 private key of a live ethers wallet. */
export function ethereumPrivateKeyFromWallet(wallet: ethers.BaseWallet): PrivateKey {
  const hex = wallet.privateKey.startsWith("0x")
    ? wallet.privateKey.slice(2)
    : wallet.privateKey
  return PrivateKey.regenerate(KeyType.EM, Bytes.fromString(hex, "hex"))
}

/** The WIRE `PUB_EM_*` public key of a live ethers wallet (from its compressed key). */
export function ethereumPublicKeyFromWallet(wallet: ethers.BaseWallet): PublicKey {
  const compressed = getCompressedPublicKey(wallet.signingKey.publicKey),
    compressedBytes = ethers.getBytes(
      compressed.startsWith("0x") ? compressed : `0x${compressed}`
    )
  return PublicKey.from({ type: "EM", compressed: compressedBytes })
}

/** A stored {@link EthereumKeyPair} (carrying its `0x` address) from a live ethers wallet. */
export function ethereumKeyPairFromWallet(wallet: ethers.BaseWallet): EthereumKeyPair {
  return {
    type: KeyType.EM,
    publicKey: ethereumPublicKeyFromWallet(wallet).toString(),
    privateKey: ethereumPrivateKeyFromWallet(wallet).toString(),
    address: wallet.address
  }
}

// ── stored SolanaKeyPair → live objects ─────────────────────────────────────

/** The sdk-core ED PrivateKey from an ED key pair (e.g. for authex-link signing). */
export function solanaSdkPrivateKey(solana: SolanaKeyPair): PrivateKey {
  return PrivateKey.from(solana.privateKey)
}

/** A web3.js Keypair reconstructed from an ED key pair. */
export function solanaKeypair(solana: SolanaKeyPair): Keypair {
  return Keypair.fromSecretKey(solanaSdkPrivateKey(solana).data.array)
}
