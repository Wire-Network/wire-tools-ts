import { ethers } from "ethers"
import { Keypair } from "@solana/web3.js"
import { match } from "ts-pattern"
import {
  Base58,
  Bytes,
  getCompressedPublicKey,
  KeyType,
  PrivateKey,
  PublicKey,
  type PublicKeyType
} from "@wireio/sdk-core"
import { WireKey, WireKeyType } from "@wireio/opp-typescript-models"
import type {
  EthereumKeyPair,
  KeyPair,
  SolanaKeyPair,
  WireFinalizerKeyPair
} from "../types/KeyPair.js"

/**
 * Derivations between the strongly-typed KeyPair structures and the live chain-SDK
 * objects — BOTH directions. The typed pairs are the stored, JSON-round-trippable
 * form (in `ClusterKeyStore` / operator outputs); these helpers (a) reconstruct the
 * ephemeral ethers/web3 signing objects from a stored pair, and (b) build a stored
 * pair from a live ethers wallet. This is DERIVATION only — key GENERATION is the
 * separate concern owned by `KeyGenerator` (see `one-generic-facade-per-concept`).
 */

// ── WIRE-canonical / chain-native private-key string → sdk-core PrivateKey ──

/**
 * The sdk-core {@link PrivateKey} parsed from a key's CHAIN-NATIVE string — the
 * exact inverse of `PrivateKey.toNativeString()`, matching what libfc's
 * `from_native_string_to_private_key` parses per type: `K1` WIF, `EM` 0x-hex of
 * the 32-byte secret, `ED` base58 of the 64-byte libsodium secret, `BLS`
 * `PVT_BLS_…` (its WIRE string IS the native form). One generic entry over the
 * closed {@link KeyType} set. Promotion candidate: belongs beside
 * `toNativeString` in `@wireio/sdk-core` on its next roll.
 *
 * @param type - The key's curve.
 * @param native - The chain-native private-key string.
 * @returns The parsed private key.
 */
export function privateKeyFromNativeString(
  type: KeyType,
  native: string
): PrivateKey {
  return match(type)
    .with(KeyType.K1, () => PrivateKey.from(native))
    // BLS's native form IS its WIRE string.
    .with(KeyType.BLS, () => PrivateKey.from(native))
    .with(KeyType.EM, () =>
      PrivateKey.regenerate(
        KeyType.EM,
        Bytes.fromString(
          native.startsWith("0x") ? native.slice(2) : native,
          "hex"
        )
      )
    )
    .with(KeyType.ED, () =>
      PrivateKey.regenerate(KeyType.ED, Base58.decode(native))
    )
    .otherwise(() => {
      throw new Error(
        `privateKeyFromNativeString: unsupported key type ${KeyType[type] ?? type}`
      )
    })
}

/**
 * Build the stored {@link KeyPair} for `keyType` from its CHAIN-NATIVE private
 * key string — exactly the value an SSM `SecureString` parameter holds (K1 WIF,
 * EM `0x`-hex, ED base58 of the 64-byte secret, BLS `PVT_BLS_…`), which is what
 * `KeySteps.runPublishSignatureProviderKey` puts and what the depot's ssm
 * plugin parses. Every member is DERIVED from the key itself, so a pair adopted
 * from an existing parameter is indistinguishable from a freshly generated one:
 *
 * - `publicKey` — `PrivateKey.toPublic()` in the Wire-canonical form.
 * - `proofOfPossession` (BLS only) — `PrivateKey.proofOfPossessionString`.
 *   VERIFIED to be reachable from `PrivateKey.from(…)`, not only from
 *   `PrivateKey.regenerate(…)`: the getter is gated on the instance's `type`,
 *   which `from` decodes off the `PVT_BLS_` prefix, so no `regenerate` fallback
 *   is needed. Genesis `initial_finalizer_key` and `ConsensusSteps.runSetFinalizer`
 *   both read this member, so a BLS pair without it is unusable.
 * - `address` (EM only) — the ethers wallet address.
 *
 * The WIRE canonical `PVT_K1_…` / `PVT_BLS_…` spellings are accepted too (they
 * ARE those curves' native form); `PVT_EM_…` / `PVT_ED_…` are NOT — those
 * curves' native forms are the hex / base58 spellings above.
 *
 * @param keyType - The key's curve.
 * @param privateKey - The chain-native private-key string.
 * @returns The stored key pair for that curve.
 */
export function keyPairFromPrivate<T extends KeyType>(
  keyType: T,
  privateKey: string
): KeyPair<T> {
  const key = privateKeyFromNativeString(keyType, privateKey),
    keyPair = match(keyType as KeyType)
      .with(
        KeyType.BLS,
        () =>
          ({
            type: KeyType.BLS,
            publicKey: key.toPublic().toString(),
            privateKey: key.toString(),
            proofOfPossession: key.proofOfPossessionString
          }) as WireFinalizerKeyPair
      )
      .with(KeyType.EM, () =>
        ethereumKeyPairFromWallet(
          new ethers.Wallet(ethers.hexlify(key.data.array))
        )
      )
      .otherwise(
        () =>
          ({
            type: keyType,
            publicKey: key.toPublic().toString(),
            privateKey: key.toString()
          }) as KeyPair
      )
  // The ONE cast — TS cannot correlate the runtime `match` arm with `T`.
  return keyPair as KeyPair<T>
}

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
 *
 * Derived from the pair's STORED public key, never from its private key: under
 * SSM custody a rehydrated pair carries `awsSecretId` in place of `privateKey`,
 * and `wire-cluster-tool run` still has to render this value into the daemon's
 * `--signature-provider` spec. The two derivations agree by construction — the
 * stored `publicKey` IS `PrivateKey.toPublic()`.
 */
export function ethereumUncompressedPublicKeyHex(ethereum: EthereumKeyPair): string {
  const compressed = PublicKey.from(ethereum.publicKey).data.array
  return `0x${ethers.SigningKey.computePublicKey(compressed, false).slice(4)}`
}

/**
 * The Solana-native (base58) public key of an ED pair, read from its STORED
 * public key rather than derived from the secret — same reason as
 * {@link ethereumUncompressedPublicKeyHex}: an SSM-custody pair holds only
 * `awsSecretId`, and the outpost signature-provider spec still names this key.
 */
export function solanaNativePublicKey(solana: SolanaKeyPair): string {
  return PublicKey.from(solana.publicKey).toNativeString()
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

// ── Wire public key → OPP proto WireKey ─────────────────────────────────────

/**
 * The OPP proto `WireKey` (variant discriminant + raw point bytes, no
 * variant-index prefix) of a Wire public key — the shape attestation payloads
 * (e.g. `NodeOwnerRegistration.wire_pub_key`) carry an account owner/active
 * authority in. Accepts every key type usable as an account authority
 * (K1/R1/EM ride the 33-byte compressed secp256k1 point, ED the 32-byte
 * ed25519 point) and throws on the rest (WA/BLS — the depot's
 * `public_key_from_wire_key` rejects them as account keys).
 *
 * @param publicKey - The Wire public key in any {@link PublicKey.from} representation
 *   (a `PUB_*` string, an sdk-core instance, or `{ type, compressed }`).
 * @returns The proto `WireKey` message.
 */
export function wireKeyFromPublicKey(publicKey: PublicKeyType): WireKey {
  const parsed = PublicKey.from(publicKey),
    keyType = match(parsed.type)
      .with(KeyType.K1, () => WireKeyType.K1)
      .with(KeyType.R1, () => WireKeyType.R1)
      .with(KeyType.EM, () => WireKeyType.EM)
      .with(KeyType.ED, () => WireKeyType.ED)
      .otherwise(() => {
        throw new Error(
          `wireKeyFromPublicKey: ${parsed.type} is not a Wire account-authority key type`
        )
      })
  return WireKey.create({ keyType, key: parsed.data.array })
}
