import Assert from "node:assert"
import { ethers } from "ethers"
import {
  Keypair,
  PublicKey as SolanaPublicKey,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js"
import { match, P } from "ts-pattern"
import nacl from "tweetnacl"
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
import { KMSClientProvider } from "../config/KMSClientProvider.js"
import type {
  EthereumKeyPair,
  KeyPair,
  SolanaKeyPair,
  WireFinalizerKeyPair
} from "../types/KeyPair.js"
import type { SolanaSigner } from "../types/SolanaSigner.js"
import { mapSeries } from "./asyncUtils.js"

/**
 * Derivations between the strongly-typed KeyPair structures and the live chain-SDK
 * objects — BOTH directions. The typed pairs are the stored, JSON-round-trippable
 * form (in `ClusterKeyStore` / operator outputs); these helpers (a) reconstruct the
 * ephemeral ethers/web3 signing objects from a stored pair, and (b) build a stored
 * pair from a live ethers wallet or a KMS public key. This is DERIVATION only —
 * key GENERATION is the separate concern owned by `KeyGenerator` (see
 * `one-generic-facade-per-concept`).
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

/**
 * Whether a KMS-custodiable pair's secret lives in AWS KMS (the pair carries a
 * key ref, never material) — the EM and ED curves, the ones KMS can custody.
 */
export function isKmsCustodied(keyPair: EthereumKeyPair | SolanaKeyPair): boolean {
  return keyPair.awsKmsKeyId != null
}

/**
 * Assert an EM pair carries its key MATERIAL — the precondition of every
 * derivation that needs the secret itself (a hardhat deployer key, a local
 * wallet). A KMS-custodied pair never does: its secret never leaves KMS, so a
 * consumer that needs raw material is simply incompatible with that custody.
 */
function assertEthereumKeyMaterial(ethereum: EthereumKeyPair): string {
  Assert.ok(
    ethereum.privateKey != null,
    `keyPairUtils: the EM key ${ethereum.address} carries no key material (${
      isKmsCustodied(ethereum)
        ? `it is custodied by AWS KMS ${ethereum.awsKmsKeyId}`
        : `it is referenced by ${ethereum.awsSecretId ?? "nothing"}`
    }) — sign through ethereumSigner instead`
  )
  return ethereum.privateKey
}

/**
 * The raw 0x-hex secp256k1 private key underlying an EM key pair — for the
 * consumers that genuinely need the material itself (the outpost deployer key
 * hardhat reads, a local wallet). Throws for a KMS-custodied pair.
 *
 * @param ethereum - The EM pair.
 * @returns The `0x`-prefixed 32-byte hex secret.
 */
export function ethereumPrivateKeyHex(ethereum: EthereumKeyPair): string {
  return ethers.hexlify(
    PrivateKey.from(assertEthereumKeyMaterial(ethereum)).data.array
  )
}

/**
 * The ONE signer facade over an EM pair's custody forms: local material → an
 * `ethers.Wallet`; AWS KMS → an ethers signer whose every signature is a remote
 * `KMS::Sign` (`KMSClientProvider.createSigner`). Connected to `provider` when
 * one is given; without one it can only sign offline (messages, typed data),
 * never send. Async because the KMS arm loads its SDK lazily.
 *
 * @param ethereum - The EM pair.
 * @param provider - The provider to connect to.
 * @returns The signer.
 */
export async function ethereumSigner(
  ethereum: EthereumKeyPair,
  provider?: ethers.Provider
): Promise<ethers.Signer> {
  return isKmsCustodied(ethereum)
    ? KMSClientProvider.createSigner(
        ethereum.awsKmsRegion,
        ethereum.awsKmsKeyId,
        provider
      )
    : new ethers.Wallet(ethereumPrivateKeyHex(ethereum), provider)
}

/**
 * The 33-byte compressed secp256k1 public key (the depot `opAddress`) from an EM
 * key pair — read off the STORED public key, so it renders for every custody
 * form (a KMS pair has no material to derive from). The two derivations agree
 * by construction: the stored `publicKey` IS the key's compressed point.
 */
export function ethereumCompressedPubkey(ethereum: EthereumKeyPair): Uint8Array {
  return PublicKey.from(ethereum.publicKey).data.array
}

/** The sdk-core EM PrivateKey from an EM key pair (native `0x…` via `toNativeString`). Throws for a KMS-custodied pair. */
export function ethereumSdkPrivateKey(ethereum: EthereumKeyPair): PrivateKey {
  return PrivateKey.from(assertEthereumKeyMaterial(ethereum))
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

// ── KMS public key → typed EM pair (the KMS-custody form) ───────────────────

/**
 * A stored {@link EthereumKeyPair} for a key AWS KMS custodies: its public
 * identity (`PUB_EM_…` + the `0x` address, both derived from the compressed
 * point KMS reports) plus the key reference — and NO `privateKey`, because the
 * secret never leaves KMS.
 *
 * @param compressed - The 33-byte compressed secp256k1 point (`KMSClientProvider.PublicKey`).
 * @param awsKmsRegion - The ONE region the key lives in.
 * @param awsKmsKeyId - The `KeyId` the key is addressed by (its alias name).
 * @returns The KMS-custodied pair.
 */
export function ethereumKeyPairFromKmsPublicKey(
  compressed: Uint8Array,
  awsKmsRegion: string,
  awsKmsKeyId: string
): EthereumKeyPair {
  return {
    type: KeyType.EM,
    publicKey: PublicKey.from({ type: "EM", compressed }).toString(),
    address: ethers.computeAddress(ethers.hexlify(compressed)),
    awsKmsRegion,
    awsKmsKeyId
  }
}

// ── stored SolanaKeyPair → live objects ─────────────────────────────────────

/**
 * Assert an ED pair carries its key MATERIAL — the ED twin of
 * {@link assertEthereumKeyMaterial}, the precondition of every derivation that
 * needs the secret itself (a local keypair). A KMS-custodied pair never does:
 * its secret never leaves KMS, so a consumer that needs raw material is simply
 * incompatible with that custody.
 */
function assertSolanaKeyMaterial(solana: SolanaKeyPair): string {
  Assert.ok(
    solana.privateKey != null,
    `keyPairUtils: the ED key ${solana.publicKey} carries no key material (${
      isKmsCustodied(solana)
        ? `it is custodied by AWS KMS ${solana.awsKmsKeyId}`
        : `it is referenced by ${solana.awsSecretId ?? "nothing"}`
    }) — sign through solanaSigner instead`
  )
  return solana.privateKey
}

/** The sdk-core ED PrivateKey from an ED key pair. Throws for a KMS-custodied pair. */
export function solanaSdkPrivateKey(solana: SolanaKeyPair): PrivateKey {
  return PrivateKey.from(assertSolanaKeyMaterial(solana))
}

/** A web3.js Keypair reconstructed from an ED key pair. Throws for a KMS-custodied pair. */
export function solanaKeypair(solana: SolanaKeyPair): Keypair {
  return Keypair.fromSecretKey(solanaSdkPrivateKey(solana).data.array)
}

/**
 * The web3.js PublicKey of an ED pair, read from its STORED public key — it
 * renders for every custody form (a KMS pair has no material to derive a
 * keypair from), and agrees with {@link solanaKeypair}'s by construction: the
 * stored `publicKey` IS the key's 32-byte point.
 */
export function solanaPublicKey(solana: SolanaKeyPair): SolanaPublicKey {
  return new SolanaPublicKey(PublicKey.from(solana.publicKey).data.array)
}

/**
 * A {@link SolanaSigner} over LOCAL material — the keypair wallet shape Anchor's
 * provider takes (`partialSign` on a legacy transaction, `sign` on a versioned
 * one, the payer exposed as Anchor's `wallet.payer`), plus raw-message signing
 * with the keypair's secret — pure Ed25519, the same detached signature
 * sdk-core's `PrivateKey.signMessage` embeds. Built on web3.js alone, so the
 * module loads wherever the harness barrel does (a renderer's jsdom included),
 * where Anchor's Node-only wallet class is absent.
 */
class KeypairSolanaSigner implements SolanaSigner {
  constructor(readonly payer: Keypair) {}

  /** @inheritdoc */
  get publicKey(): SolanaPublicKey {
    return this.payer.publicKey
  }

  /** @inheritdoc */
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, this.payer.secretKey)
  }

  /** @inheritdoc */
  async signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T
  ): Promise<T> {
    match(transaction as Transaction | VersionedTransaction)
      .with(P.instanceOf(VersionedTransaction), versioned =>
        versioned.sign([this.payer])
      )
      .otherwise(legacy => legacy.partialSign(this.payer))
    return transaction
  }

  /** @inheritdoc */
  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[]
  ): Promise<T[]> {
    return mapSeries(transactions, transaction => this.signTransaction(transaction))
  }
}

/**
 * The {@link SolanaSigner} of a live web3.js keypair — the local-custody
 * backend of {@link solanaSigner}, and what a flow's persisted keypair (a
 * user, the deployer, a cranker) signs through where a tool takes a signer.
 *
 * @param keypair - The live keypair.
 * @returns The signer.
 */
export function solanaSignerFromKeypair(keypair: Keypair): SolanaSigner {
  return new KeypairSolanaSigner(keypair)
}

/**
 * The ONE signer facade over an ED pair's custody forms — the Solana twin of
 * {@link ethereumSigner}: local material → a signer backed by the
 * reconstructed `Keypair`; AWS KMS → a signer whose every signature is a
 * remote `KMS::Sign` (`KMSClientProvider.createSolanaSigner`), verified
 * against the pair's stored public key. Async because the KMS arm loads its
 * SDK lazily.
 *
 * @param solana - The ED pair.
 * @returns The signer.
 */
export async function solanaSigner(solana: SolanaKeyPair): Promise<SolanaSigner> {
  return isKmsCustodied(solana)
    ? KMSClientProvider.createSolanaSigner(
        solana.awsKmsRegion,
        solana.awsKmsKeyId,
        PublicKey.from(solana.publicKey).data.array
      )
    : solanaSignerFromKeypair(solanaKeypair(solana))
}

// ── KMS public key → typed ED pair (the KMS-custody form) ───────────────────

/**
 * A stored {@link SolanaKeyPair} for a key AWS KMS custodies: its public
 * identity (`PUB_ED_…`, derived from the 32-byte point KMS reports) plus the
 * key reference — and NO `privateKey`, because the secret never leaves KMS.
 * The ED twin of {@link ethereumKeyPairFromKmsPublicKey}.
 *
 * @param publicKey - The 32-byte Ed25519 point (`KMSClientProvider.PublicKey`).
 * @param awsKmsRegion - The ONE region the key lives in.
 * @param awsKmsKeyId - The `KeyId` the key is addressed by (its alias name).
 * @returns The KMS-custodied pair.
 */
export function solanaKeyPairFromKmsPublicKey(
  publicKey: Uint8Array,
  awsKmsRegion: string,
  awsKmsKeyId: string
): SolanaKeyPair {
  return {
    type: KeyType.ED,
    publicKey: PublicKey.from({ type: KeyType.ED, compressed: publicKey }).toString(),
    awsKmsRegion,
    awsKmsKeyId
  }
}

// ── live web3.js Keypair → typed ED pair (the inverse of solanaKeypair) ────

/**
 * A stored {@link SolanaKeyPair} from a live web3.js keypair — the ED
 * counterpart of {@link ethereumKeyPairFromWallet}, and the exact inverse of
 * {@link solanaKeypair}: a keypair persisted by handle
 * (`SolanaFundingTool.createKeypair`) becomes the typed pair an
 * `OperatorAccount.solana` carries, with the public half derived from the
 * secret.
 *
 * @param keypair - The live keypair (its 64-byte secret holds the seed + the point).
 * @returns The stored pair (`PUB_ED_…` / `PVT_ED_…`).
 */
export function solanaKeyPairFromKeypair(keypair: Keypair): SolanaKeyPair {
  return keyPairFromPrivate(KeyType.ED, Base58.encode(keypair.secretKey))
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
