import Assert from "node:assert"
import { asOption } from "@3fv/prelude-ts"
import { ethers } from "ethers"
import { identity } from "lodash"
import {
  PublicKey as SolanaPublicKey,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js"
import { match, P } from "ts-pattern"
import nacl from "tweetnacl"
import {
  hexToArray,
  KeyType,
  PublicKey as WirePublicKey,
  Signature,
  type SignatureParts,
  type SignerProvider
} from "@wireio/sdk-core"
import { Deferred, getLogger, NestedError } from "@wireio/shared"
import type { KMSCustodiedKeyType } from "@wireio/cluster-tool-shared"
import type { KeySpec, KMSClient, Tag } from "@aws-sdk/client-kms"
import type { SolanaSigner } from "../types/SolanaSigner.js"
import { mapSeries } from "../utils/asyncUtils.js"

const log = getLogger(__filename)

/** The `@aws-sdk/client-kms` module surface, loaded lazily (type-only static import). */
type KMSModule = typeof import("@aws-sdk/client-kms")

let importKMSModuleDeferred: Deferred<KMSModule> = null

/**
 * Load `@aws-sdk/client-kms` once through a single cached accessor
 * (`dynamic-import-esm-only-deps.md`) — the SDK is heavy and only the KMS paths
 * need it. Cache assigned SYNCHRONOUSLY (before the first `await`) so concurrent
 * callers share the one in-flight import.
 */
function importKMSModule(): Promise<KMSModule> {
  if (importKMSModuleDeferred === null) {
    importKMSModuleDeferred = new Deferred()
    import("@aws-sdk/client-kms")
      .then(kmsModule => importKMSModuleDeferred.resolve(kmsModule))
      .catch(error => {
        const failed = importKMSModuleDeferred
        importKMSModuleDeferred = null
        failed.reject(error)
      })
  }
  return importKMSModuleDeferred.promise
}

/**
 * THE single AWS KMS access surface — the cached SDK accessor + per-region
 * `KMSClient` cache shared by every KMS path: the create path's GENERATION seam
 * (`KeySteps.adoptOrCreateSignatureProviderKey`, which ADOPTS an existing key
 * by alias rather than mint a replacement), the batch-operator key
 * pre-creation, `keyPairUtils.wireSigner`, whose KMS arm signs through
 * {@link createWireSigner}, `keyPairUtils.ethereumSigner`, whose KMS arm signs
 * through {@link createSigner}, and `keyPairUtils.solanaSigner`, whose KMS arm
 * signs through {@link createSolanaSigner}. Every signer is this module's own,
 * built on that one cached client per region — no other KMS client exists in
 * the harness, so every `Sign` gets the same adaptive-retry treatment.
 *
 * KMS custodies the wire (K1, secp256k1, `ECC_SECG_P256K1`), ethereum (EM,
 * secp256k1, `ECC_SECG_P256K1`) and solana (ED, Ed25519,
 * `ECC_NIST_EDWARDS25519`) keys — `KMSCustodiedKeyTypes` — never a BLS key,
 * and a K1 only as a batch operator's WIRE account key: a producer's
 * block-signing K1 must stay local (`producer_plugin` requires a local
 * private key for every WIRE key on a node with producers configured —
 * wire-sysio #768). The private key is generated inside KMS and never leaves
 * it — there is no material to fetch, so unlike `SSMClientProvider` nothing
 * here ever returns a secret. Every key {@link createKey} mints is a
 * multi-Region PRIMARY (`MultiRegion: true`, key id `mrk-…`), so it can later
 * be replicated into another region without changing its public key — a
 * separate, deliberate step the harness never performs — and
 * {@link PublicKey.multiRegion} reports whether an adopted key is one, read
 * off its ARN ({@link isMultiRegionKeyArn}). There is deliberately NO delete
 * (`ScheduleKeyDeletion`): a key under an alias is the AWS ACCOUNT's durable
 * key identity, which the next `create` adopts — and the funding a pre-launch
 * deployment binds to it is unrecoverable once the key is gone. The one key
 * nothing adopts — one {@link createKey} minted but could not bind its alias
 * to — is reported as ORPHANED (logged, and thrown with its ARN) for hand
 * cleanup, never deleted.
 */
export namespace KMSClientProvider {
  /**
   * The DER `SubjectPublicKeyInfo` header KMS wraps an Ed25519 public key in
   * (RFC 8410): `SEQUENCE { SEQUENCE { OID 1.3.101.112 }, BIT STRING { 00
   * <key> } }` — id-Ed25519 with NO parameters, a zero unused-bits octet, then
   * the 32-byte key. Exactly what nodeop's `spki_der_to_ed25519_public_key`
   * requires.
   */
  export const Ed25519SpkiPrefix = Uint8Array.of(
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
  )
  /** Length of an Ed25519 public key — the 32 raw bytes a Solana key IS. */
  export const Ed25519PublicKeyLength = nacl.sign.publicKeyLength
  /** Length of a whole Ed25519 SPKI: the header plus the key (44 bytes). */
  export const Ed25519SpkiLength =
    Ed25519SpkiPrefix.length + Ed25519PublicKeyLength
  /** Length of a detached Ed25519 signature — what `Sign` returns for `ED25519_SHA_512`. */
  export const Ed25519SignatureLength = nacl.sign.signatureLength
  /**
   * The largest message KMS signs with `MessageType.RAW` (bytes). A Solana
   * transaction message is at most 1232, so the limit is never reached by a
   * transaction; an authex link payload is 64.
   */
  export const MaxRawMessageLength = 4096

  /** Every KMS alias name starts with this prefix (`alias/aws/` is reserved by AWS). */
  export const AliasPrefix = "alias/"

  /**
   * The character set KMS accepts in an alias name after {@link AliasPrefix}:
   * no dots — which is why a WIRE account handle's `.` renders as
   * {@link AccountAliasSeparator}.
   */
  export const AliasNamePattern = /^alias\/[a-zA-Z0-9/_-]+$/

  /** What a `{account}` handle's dot becomes inside an alias name (`batchop.a` → `batchop-a`). */
  export const AccountAliasSeparator = "-"

  /** The dot a WIRE account handle separates its segments with. */
  const AccountSegmentSeparator = "."

  /**
   * The prefix AWS gives every multi-Region key's key id (`mrk-…`) — the ONE
   * mark {@link isMultiRegionKeyArn} reads: `GetPublicKey` reports no
   * multi-Region flag, and the harness role deliberately has no
   * `kms:DescribeKey`.
   */
  export const MultiRegionKeyIdPrefix = "mrk-"
  /** The scheme every AWS ARN starts with. */
  const ArnPrefix = "arn:"
  /** The field separator of an ARN (`arn:partition:service:region:account:resource`). */
  const ArnFieldSeparator = ":"
  /** The ARN field holding the resource — `key/<id>` for a key, `alias/<name>` for an alias. */
  const ArnResourceFieldIndex = 5
  /** The resource prefix of a KEY ARN (`…:key/<id>`); an alias ARN carries `alias/` there instead. */
  const KeyArnResourcePrefix = "key/"

  /** Length of an uncompressed secp256k1 point (`04 || X || Y`). */
  export const UncompressedPointLength = 65
  /** The SEC1 uncompressed-point marker byte. */
  export const UncompressedPointPrefix = 0x04
  /** Length of a compressed secp256k1 point (`02|03 || X`). */
  export const CompressedPointLength = 33

  /** Length of the SHA-256 digest a WIRE K1 signer signs — a transaction's signing digest. */
  export const Sha256DigestLength = 32
  /**
   * Length of the keccak256 digest an Ethereum signer signs — a message hash
   * (`hashMessage`), a transaction's `unsignedHash` or a typed-data hash — the
   * same 32 bytes `ECDSA_SHA_256` as `MessageType = DIGEST` takes.
   */
  export const Keccak256DigestLength = 32
  /** Length of a secp256k1 scalar — each of an ECDSA signature's `r` and `s`. */
  export const Secp256k1ScalarLength = 32
  /** Length of a WIRE K1 raw signature `[r(32) ‖ s(32) ‖ recid(1)]` — what `Signature.fromRaw` takes. */
  export const K1RawSignatureLength = Secp256k1ScalarLength * 2 + 1
  /** Offset of `s` inside a K1 raw signature. */
  const K1RawSignatureSOffset = Secp256k1ScalarLength
  /** Offset of the recovery id inside a K1 raw signature. */
  const K1RawSignatureRecoveryIdOffset = Secp256k1ScalarLength * 2
  /**
   * The order `n` of the secp256k1 group. An ECDSA `s` and `n − s` are both
   * valid; the WIRE form is the LOW one (`s ≤ n / 2`), as wire-sysio #768's
   * `der_to_wire_k1_signature` normalises it.
   */
  export const Secp256k1GroupOrder =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
  /** The largest low-S `s` — `n / 2` (`n` is odd, so the integer half). */
  const Secp256k1HalfGroupOrder = Secp256k1GroupOrder / 2n
  /** The two recovery ids a K1 signature can carry — the parity of the ephemeral point. */
  const RecoveryIds = [0, 1] as const
  /** The DER tag of a `SEQUENCE` — the wrapper of the signature KMS returns. */
  export const DerSequenceTag = 0x30
  /** The DER tag of an `INTEGER` — each of the signature's two scalars. */
  export const DerIntegerTag = 0x02
  /** Bytes of a DER tag + short-form length header. */
  const DerHeaderLength = 2
  /** A DER short-form length is below this; the signature never needs the long form (at most 70 bytes). */
  const DerShortFormLengthLimit = 0x80
  /** The zero octet DER prepends to an INTEGER whose high bit is set (sign padding). */
  const DerZeroOctet = 0x00

  /**
   * The `name` AWS KMS gives the error for a key id / alias that does not
   * exist. It is the ONLY failure {@link tryGetPublicKey} treats as "nothing to
   * adopt" — every other one propagates.
   */
  const NotFoundErrorName = "NotFoundException"

  /** SDK retry mode for every KMS client — see `SSMClientProvider` for the why. */
  const AdaptiveRetryMode = "adaptive"
  /** Attempts per KMS call (key creation bursts are throttled like parameter publication). */
  const MaxRetryAttempts = 10

  /** Per-region `KMSClient` cache (mirrors the C++ `get_kms_client` cache). */
  const kmsClientsByRegion = new Map<string, KMSClient>()

  /** A KMS signing key's PUBLIC identity — everything a KMS-custodied pair needs besides its custody ref. */
  export interface PublicKey {
    /** The key's ARN, as KMS reports it (the durable identity behind the alias). */
    readonly keyArn: string
    /** The curve the key signs for — the one its KMS key spec was verified against. */
    readonly keyType: KMSCustodiedKeyType
    /**
     * Whether the key is a multi-Region key — its key id begins with
     * {@link MultiRegionKeyIdPrefix}, read off the ARN `GetPublicKey` reports.
     * Every key {@link createKey} mints is one; an adopted key may predate that
     * mark, and such a single-Region key can never be replicated.
     */
    readonly multiRegion: boolean
    /**
     * The curve-canonical public key bytes: the 33-byte compressed secp256k1
     * point of a K1 or EM key, the 32-byte Ed25519 point of an ED key.
     */
    readonly publicKey: Uint8Array
  }

  /**
   * The two scalars of an ECDSA signature as KMS returns them — the `r` / `s`
   * members of sdk-core's `SignatureParts` (typed off it), each left-padded to
   * {@link Secp256k1ScalarLength}; no recovery id yet (KMS reports none).
   */
  export interface Secp256k1SignatureScalars {
    /** The signature's `r` scalar, 32 bytes. */
    readonly r: SignatureParts["r"]
    /**
     * The signature's `s` scalar, 32 bytes — as KMS signed it off
     * {@link secp256k1SignatureFromDer}, low-S normalised off {@link signEcdsaDigest}.
     */
    readonly s: SignatureParts["s"]
  }

  /** One DER `INTEGER` read off a signature: its fixed-width scalar and the offset after it. */
  interface DerIntegerRead {
    /** The scalar, left-padded to {@link Secp256k1ScalarLength}. */
    readonly scalar: Uint8Array
    /** The offset of the byte after the INTEGER. */
    readonly next: number
  }

  /** The KMS key an Ethereum signer is pinned to: where it lives, how it is addressed and the address it signs for. */
  interface KMSEthereumSignerKey {
    /** The region the key lives in. */
    readonly region: string
    /** Any `KeyId` KMS accepts (alias name, key id, key / alias ARN). */
    readonly keyId: string
    /** The checksummed address of the key's public point — what every signature must recover to. */
    readonly address: string
  }

  /**
   * The KMS key spec a custodied curve needs — secp256k1 for a K1 / EM key,
   * Ed25519 for an ED key: the ONE map from `KeyType` to key spec, read off
   * the SDK's own roster.
   */
  function signingKeySpec(
    kms: KMSModule,
    keyType: KMSCustodiedKeyType
  ): KeySpec {
    return match(keyType)
      .with(KeyType.K1, () => kms.KeySpec.ECC_SECG_P256K1)
      .with(KeyType.EM, () => kms.KeySpec.ECC_SECG_P256K1)
      .with(KeyType.ED, () => kms.KeySpec.ECC_NIST_EDWARDS25519)
      .exhaustive()
  }

  /**
   * Render the `{account}` segment of a KMS alias: a WIRE handle's dots become
   * {@link AccountAliasSeparator}, which KMS accepts and a WIRE name never
   * contains — so the mapping is injective.
   *
   * @param account - The key's durable handle (`batchop.a`).
   * @returns The alias-safe segment (`batchop-a`).
   */
  export function aliasAccountSegment(account: string): string {
    return account.replaceAll(AccountSegmentSeparator, AccountAliasSeparator)
  }

  /**
   * Assert `aliasName` is a KMS alias name — `alias/` plus `[a-zA-Z0-9/_-]`.
   *
   * @param aliasName - The rendered alias.
   * @returns `aliasName`, validated.
   */
  export function assertAliasName(aliasName: string): string {
    Assert.ok(
      AliasNamePattern.test(aliasName),
      `KMSClientProvider: "${aliasName}" is not a KMS alias name — it must start with ${AliasPrefix} and contain only letters, digits, '/', '_' and '-'`
    )
    return aliasName
  }

  /**
   * Whether `keyArn` names a multi-Region key: its key id — the segment after
   * `key/` of a key ARN, or a bare key id as is — begins with
   * {@link MultiRegionKeyIdPrefix}. An alias ARN or alias name names no key id
   * and is never one. The property is fixed at creation — a single-Region key
   * can never be converted or replicated — which is why the mark is worth
   * reading off an adopted key.
   *
   * @param keyArn - A key ARN (`arn:aws:kms:…:key/<id>`) or a bare key id.
   * @returns Whether the key is a multi-Region key.
   */
  export function isMultiRegionKeyArn(keyArn: string): boolean {
    return keyIdOf(keyArn).startsWith(MultiRegionKeyIdPrefix)
  }

  /**
   * The key id `keyArn` names: the segment after `key/` of a key ARN, a bare
   * key id unchanged, nothing for any other ARN (an alias ARN carries `alias/`
   * where a key ARN carries `key/`).
   */
  function keyIdOf(keyArn: string): string {
    return match(keyArn)
      .with(P.string.startsWith(ArnPrefix), arn =>
        asOption(arn.split(ArnFieldSeparator)[ArnResourceFieldIndex])
          .filter(resource => resource.startsWith(KeyArnResourcePrefix))
          .map(resource => resource.slice(KeyArnResourcePrefix.length))
          .getOrElse("")
      )
      .otherwise(identity)
  }

  /** Get-or-create the cached `KMSClient` for `region`. */
  async function kmsClientForRegion(region: string): Promise<KMSClient> {
    Assert.ok(
      region.length > 0,
      "KMSClientProvider: a KMS key is regional — region is required"
    )
    const cached = kmsClientsByRegion.get(region)
    if (cached != null) return cached
    const { KMSClient } = await importKMSModule()
    const client = new KMSClient({
      region,
      retryMode: AdaptiveRetryMode,
      maxAttempts: MaxRetryAttempts
    })
    kmsClientsByRegion.set(region, client)
    return client
  }

  /**
   * Whether `error` is KMS's `NotFoundException` (the key / alias does not
   * exist). Matched by NAME, not by class — the lazily-imported SDK's class
   * would be a second module instance to an `instanceof`.
   */
  function isNotFound(error: unknown): boolean {
    return match(error)
      .with(P.instanceOf(Error), ({ name }) => name === NotFoundErrorName)
      .otherwise(() => false)
  }

  /**
   * The compressed secp256k1 point of a KMS `GetPublicKey` response — the DER
   * `SubjectPublicKeyInfo` ends with the uncompressed point (`04 || X || Y`),
   * exactly what nodeop's `spki_der_to_public_key` strips; ethers compresses it.
   *
   * @param spki - The DER-encoded SPKI KMS returns.
   * @returns The 33-byte compressed point.
   */
  export function compressedPointFromSpki(spki: Uint8Array): Uint8Array {
    Assert.ok(
      spki.length >= UncompressedPointLength,
      `KMSClientProvider: SPKI of ${spki.length} bytes is too short to carry an uncompressed secp256k1 point`
    )
    const uncompressed = spki.slice(spki.length - UncompressedPointLength)
    Assert.ok(
      uncompressed[0] === UncompressedPointPrefix,
      `KMSClientProvider: SPKI does not end with an uncompressed secp256k1 point (marker 0x${uncompressed[0].toString(16)})`
    )
    const compressed = ethers.getBytes(
      ethers.SigningKey.computePublicKey(ethers.hexlify(uncompressed), true)
    )
    Assert.strictEqual(
      compressed.length,
      CompressedPointLength,
      "KMSClientProvider: compressed point length"
    )
    return compressed
  }

  /**
   * The 32-byte Ed25519 public key of a KMS `GetPublicKey` response — the DER
   * `SubjectPublicKeyInfo` is exactly {@link Ed25519SpkiPrefix} followed by the
   * key (RFC 8410: id-Ed25519, no parameters), the same shape nodeop's
   * `spki_der_to_ed25519_public_key` decodes; its base58 is the Solana key.
   *
   * @param spki - The DER-encoded SPKI KMS returns.
   * @returns The 32 raw key bytes.
   */
  export function ed25519PublicKeyFromSpki(spki: Uint8Array): Uint8Array {
    Assert.strictEqual(
      spki.length,
      Ed25519SpkiLength,
      `KMSClientProvider: SPKI of ${spki.length} bytes is not an Ed25519 SubjectPublicKeyInfo (${Ed25519SpkiLength} bytes)`
    )
    Assert.ok(
      Ed25519SpkiPrefix.every((byte, index) => spki[index] === byte),
      "KMSClientProvider: SPKI does not carry id-Ed25519 (1.3.101.112) with no parameters — the KMS key must be created with key spec ECC_NIST_EDWARDS25519"
    )
    return spki.slice(Ed25519SpkiPrefix.length)
  }

  /** The curve-canonical public key bytes of a KMS SPKI, decoded per curve. */
  function publicKeyFromSpki(
    keyType: KMSCustodiedKeyType,
    spki: Uint8Array
  ): Uint8Array {
    return match(keyType)
      .with(KeyType.K1, () => compressedPointFromSpki(spki))
      .with(KeyType.EM, () => compressedPointFromSpki(spki))
      .with(KeyType.ED, () => ed25519PublicKeyFromSpki(spki))
      .exhaustive()
  }

  /**
   * Read the DER `INTEGER` at `offset`: the tag, a short-form length, then the
   * big-endian magnitude — whose sign-padding zero octet(s) are stripped and
   * which is left-padded back to {@link Secp256k1ScalarLength}. A scalar that
   * is zero, longer than a secp256k1 scalar or not below the group order is
   * refused: KMS never produces one, so it is a corrupted response.
   */
  function derInteger(der: Uint8Array, offset: number, what: string): DerIntegerRead {
    Assert.ok(
      der.length >= offset + DerHeaderLength && der[offset] === DerIntegerTag,
      `KMSClientProvider: ECDSA signature DER carries no INTEGER ${what} at offset ${offset}`
    )
    const length = der[offset + DerHeaderLength - 1],
      start = offset + DerHeaderLength,
      next = start + length
    Assert.ok(
      length > 0 && length < DerShortFormLengthLimit && next <= der.length,
      `KMSClientProvider: ECDSA signature DER INTEGER ${what} has an invalid length ${length}`
    )
    const integer = der.subarray(start, next),
      leadingZeros = integer.findIndex(byte => byte !== DerZeroOctet),
      magnitude = leadingZeros < 0 ? new Uint8Array(0) : integer.subarray(leadingZeros)
    Assert.ok(
      magnitude.length > 0 && magnitude.length <= Secp256k1ScalarLength,
      `KMSClientProvider: ECDSA signature ${what} is not a secp256k1 scalar (${magnitude.length} significant bytes)`
    )
    const scalar = new Uint8Array(Secp256k1ScalarLength)
    scalar.set(magnitude, Secp256k1ScalarLength - magnitude.length)
    Assert.ok(
      ethers.toBigInt(scalar) < Secp256k1GroupOrder,
      `KMSClientProvider: ECDSA signature ${what} is not below the secp256k1 group order`
    )
    return { scalar, next }
  }

  /**
   * The `r` and `s` of the DER-encoded ECDSA signature KMS's `Sign` returns —
   * `SEQUENCE { INTEGER r, INTEGER s }` (RFC 3279), the ONE encoding
   * `ECDSA_SHA_256` produces. A minimal, asserting parser like
   * {@link ed25519PublicKeyFromSpki}: the sequence tag and length, exactly two
   * INTEGERs, nothing trailing; each scalar's sign padding stripped and the
   * value left-padded to 32 bytes. The scalars come back exactly as KMS signed
   * them — low-S normalisation is {@link signEcdsaDigest}'s job, the recovery
   * id each signer's own.
   *
   * @param der - The DER-encoded signature.
   * @returns The two 32-byte scalars.
   */
  export function secp256k1SignatureFromDer(
    der: Uint8Array
  ): Secp256k1SignatureScalars {
    Assert.ok(
      der.length > DerHeaderLength && der[0] === DerSequenceTag,
      `KMSClientProvider: ECDSA signature of ${der.length} bytes is not a DER SEQUENCE`
    )
    const sequenceLength = der[DerHeaderLength - 1]
    Assert.ok(
      sequenceLength < DerShortFormLengthLimit &&
        sequenceLength === der.length - DerHeaderLength,
      `KMSClientProvider: ECDSA signature DER SEQUENCE length ${sequenceLength} does not match its ${der.length - DerHeaderLength} content bytes`
    )
    const { scalar: r, next: afterR } = derInteger(der, DerHeaderLength, "r"),
      { scalar: s, next: afterS } = derInteger(der, afterR, "s")
    Assert.strictEqual(
      afterS,
      der.length,
      `KMSClientProvider: ECDSA signature DER carries ${der.length - afterS} trailing bytes after s`
    )
    return { r, s }
  }

  /**
   * `s` normalised to the low half of the group order — `n − s` when `s > n / 2`,
   * else `s` as is — the WIRE K1 signature form (wire-sysio #768's
   * `der_to_wire_k1_signature`). The complement signs the same digest under
   * the opposite recovery-id parity, which each signer re-derives —
   * {@link createWireSigner} against the pinned public key, {@link createSigner}
   * against the pinned address.
   */
  function lowS(s: Uint8Array): Uint8Array {
    const value = ethers.toBigInt(s)
    return value > Secp256k1HalfGroupOrder
      ? ethers.getBytes(
          ethers.toBeHex(Secp256k1GroupOrder - value, Secp256k1ScalarLength)
        )
      : s
  }

  /** The 65-byte WIRE K1 raw signature `[r ‖ s ‖ recid]` — the layout `Signature.fromRaw(…, KeyType.K1)` takes. */
  function k1RawSignature(r: Uint8Array, s: Uint8Array, recoveryId: number): Uint8Array {
    const raw = new Uint8Array(K1RawSignatureLength)
    raw.set(r, 0)
    raw.set(s, K1RawSignatureSOffset)
    raw[K1RawSignatureRecoveryIdOffset] = recoveryId
    return raw
  }

  /**
   * The 32-byte signing digest a WIRE K1 signer receives — a `Uint8Array`, or
   * its bare hex (the same two forms `createClassicSigner` takes, parsed with
   * the same `hexToArray`). For a K1 key `Transaction.signingDigest`'s
   * `msgBytes` IS this digest; anything of another length is refused before a
   * `Sign` is sent.
   */
  function signingDigest(message: string | Uint8Array): Uint8Array {
    const digest = match(message).with(P.string, hexToArray).otherwise(identity)
    Assert.strictEqual(
      digest.length,
      Sha256DigestLength,
      `KMSClientProvider: a WIRE K1 signer signs the ${Sha256DigestLength}-byte sha256 signing digest, got ${digest.length} bytes`
    )
    return digest
  }

  /**
   * ONE `KMS::Sign` of a 32-byte digest by an `ECC_SECG_P256K1` key —
   * `MessageType = DIGEST` under `SigningAlgorithm = ECDSA_SHA_256`, the DER
   * `SEQUENCE { INTEGER r, INTEGER s }` it returns parsed
   * ({@link secp256k1SignatureFromDer}) and `s` normalised to the low half of
   * the group order ({@link lowS}). The ECDSA core both secp256k1 signers
   * share; the recovery id is each one's own — {@link createWireSigner}
   * recovers against the pinned WIRE public key, {@link createSigner} against
   * the pinned Ethereum address — so a signer wired to the wrong key is refused
   * there, before anything is sent on chain.
   */
  async function signEcdsaDigest(
    kms: KMSModule,
    client: KMSClient,
    region: string,
    keyId: string,
    digest: Uint8Array
  ): Promise<Secp256k1SignatureScalars> {
    const { Signature: der } = await client.send(
      new kms.SignCommand({
        KeyId: keyId,
        Message: digest,
        MessageType: kms.MessageType.DIGEST,
        SigningAlgorithm: kms.SigningAlgorithmSpec.ECDSA_SHA_256
      })
    )
    Assert.ok(
      der != null && der.length > 0,
      `KMSClientProvider: ${keyId} in ${region} returned no ECDSA signature`
    )
    const { r, s } = secp256k1SignatureFromDer(der)
    return { r, s: lowS(s) }
  }

  /**
   * Fetch a signing key's public identity — `GetPublicKey`, requiring the
   * `SIGN_VERIFY` key of the spec `keyType` needs (secp256k1 for a K1 / EM key,
   * Ed25519 for an ED key).
   *
   * @param region - The region the key lives in.
   * @param keyId - Any `KeyId` KMS accepts (alias name, key id, key / alias ARN).
   * @param keyType - The curve the key must sign for.
   * @returns The key's ARN, curve, multi-Region mark and curve-canonical public key bytes.
   */
  export async function getPublicKey(
    region: string,
    keyId: string,
    keyType: KMSCustodiedKeyType
  ): Promise<PublicKey> {
    const kms = await importKMSModule(),
      client = await kmsClientForRegion(region),
      response = await client.send(new kms.GetPublicKeyCommand({ KeyId: keyId })),
      keySpec = signingKeySpec(kms, keyType)
    Assert.ok(
      response.PublicKey != null && response.KeyId != null,
      `KMSClientProvider: GetPublicKey for ${keyId} in ${region} returned no public key`
    )
    Assert.strictEqual(
      response.KeySpec,
      keySpec,
      `KMSClientProvider: ${keyId} in ${region} is a ${response.KeySpec} key, not ${keySpec} (the spec a ${KeyType[keyType]} key needs)`
    )
    Assert.strictEqual(
      response.KeyUsage,
      kms.KeyUsageType.SIGN_VERIFY,
      `KMSClientProvider: ${keyId} in ${region} is a ${response.KeyUsage} key, not ${kms.KeyUsageType.SIGN_VERIFY}`
    )
    return {
      keyArn: response.KeyId,
      keyType,
      // `GetPublicKey` reports no multi-Region flag; the key id's prefix is the mark.
      multiRegion: isMultiRegionKeyArn(response.KeyId),
      publicKey: publicKeyFromSpki(keyType, response.PublicKey)
    }
  }

  /**
   * Fetch a key that MAY NOT EXIST — the adopt-existing probe. Returns the
   * public identity when the alias / id resolves, and nothing when KMS reports
   * `NotFoundException`. ONLY that error is absence, matched BY NAME: an
   * `AccessDeniedException`, a throttle or a wrong-spec key propagates — treating
   * one as "nothing to adopt" would mint a replacement for a key the account
   * already owns and strand the funding bound to it.
   *
   * @param region - The region the key lives in.
   * @param keyId - Any `KeyId` KMS accepts.
   * @param keyType - The curve the key must sign for.
   * @returns The public identity, or nothing when the key does not exist.
   */
  export async function tryGetPublicKey(
    region: string,
    keyId: string,
    keyType: KMSCustodiedKeyType
  ): Promise<PublicKey> {
    try {
      return await getPublicKey(region, keyId, keyType)
    } catch (error) {
      if (!isNotFound(error)) throw error
      log.debug(
        `KMSClientProvider: ${keyId} does not exist in ${region} — nothing to adopt (${
          error instanceof Error ? error.message : String(error)
        })`
      )
      return null
    }
  }

  /**
   * Create a NEW signing key of the spec `keyType` needs (secp256k1 for K1 /
   * EM, Ed25519 for ED) and bind `aliasName` to it — the generation backend of
   * a KMS-custodied key.
   *
   * Every key the harness creates is a multi-Region PRIMARY (`MultiRegion:
   * true`; AWS gives it a `mrk-…` key id): AWS fixes the property at creation —
   * a single-Region key can never be converted or replicated — while a primary
   * can LATER be replicated into another region (`ReplicateKey`, plus an alias
   * in that region) without changing its public key, hence without touching
   * the on-chain identities keyed by it (the WIRE account key, the EM address,
   * the ED key). That replication is a separate, deliberate step the harness
   * never performs; the mark itself is unconditional — there is no knob — and
   * a KMS that did not honour it fails here, before the alias is bound.
   *
   * The alias is the key's durable id: `CreateAlias` fails when the name is
   * already bound, so reaching here for an existing alias means the adopt probe
   * and this write disagreed, and the run fails loudly instead of re-pointing
   * the alias. `CreateKey` and `CreateAlias` are two calls with no transaction
   * around them: once the key exists, anything that stops the alias from being
   * bound to it — the multi-Region check, the `CreateAlias` itself — leaves a
   * key that is billable and that no adopt probe will ever find, and the
   * harness has no `ScheduleKeyDeletion` to take it back. Such a key is
   * reported as ORPHANED: logged at error level with its ARN, the region and
   * the alias it was meant to carry, and thrown as a `NestedError` naming the
   * same three (with the failure as its cause), so an operator can alias it or
   * schedule its deletion by hand.
   *
   * @param region - The region the key lives in — the primary's region.
   * @param aliasName - The alias to bind (`alias/…`).
   * @param keyType - The curve the key signs for.
   * @param description - The key's KMS description (what it is for).
   * @param tags - Tags applied at creation (omit for none).
   * @returns The new key's public identity.
   */
  export async function createKey(
    region: string,
    aliasName: string,
    keyType: KMSCustodiedKeyType,
    description: string,
    tags: readonly Tag[] = []
  ): Promise<PublicKey> {
    assertAliasName(aliasName)
    const kms = await importKMSModule(),
      client = await kmsClientForRegion(region),
      created = await client.send(
        new kms.CreateKeyCommand({
          KeySpec: signingKeySpec(kms, keyType),
          KeyUsage: kms.KeyUsageType.SIGN_VERIFY,
          Description: description,
          // A multi-Region PRIMARY, unconditionally — replicable later, never convertible.
          MultiRegion: true,
          ...(tags.length > 0 ? { Tags: [...tags] } : {})
        })
      ),
      keyArn = created.KeyMetadata?.Arn
    Assert.ok(
      keyArn != null,
      `KMSClientProvider: CreateKey in ${region} returned no key ARN`
    )
    try {
      Assert.ok(
        isMultiRegionKeyArn(keyArn),
        `KMSClientProvider: CreateKey in ${region} returned ${keyArn}, which is not a multi-Region key (its key id must begin with ${MultiRegionKeyIdPrefix}) — KMS did not honour MultiRegion, and a single-Region key can never be replicated`
      )
      await client.send(
        new kms.CreateAliasCommand({ AliasName: aliasName, TargetKeyId: keyArn })
      )
    } catch (error) {
      // The key exists and nothing names it — say so where an operator will read it.
      log.error(
        `KMSClientProvider: key ${keyArn} in ${region} is ORPHANED — created, but binding ${aliasName} to it failed (${NestedError.toError(error).message}); it is billable and invisible to adoption — alias it or schedule its deletion by hand, the harness has no delete permission`
      )
      throw new NestedError(
        `KMSClientProvider: created key ${keyArn} in ${region} is orphaned — binding ${aliasName} to it failed, so the key is billable and invisible to adoption; alias it or schedule its deletion by hand (the harness has no delete permission)`,
        { cause: error, context: { keyArn, aliasName, region } }
      )
    }
    log.info(
      `KMSClientProvider: created ${KeyType[keyType]} multi-Region key ${keyArn} in ${region} as ${aliasName}`
    )
    return getPublicKey(region, aliasName, keyType)
  }

  /**
   * The ethers signer over a KMS-custodied `ECC_SECG_P256K1` key — what
   * {@link createSigner} returns: an ethers `AbstractSigner` pinned at creation
   * to the address its KMS public key derives, whose every signature — a
   * message, a transaction, typed data — is ONE remote `KMS::Sign` of the
   * 32-byte keccak256 digest through the cached regional client
   * ({@link signEcdsaDigest}: `MessageType = DIGEST`, `ECDSA_SHA_256`, the DER
   * parsed, `s` low-S normalised), with the recovery id found by recovering
   * each parity to the pinned address — so a signer wired to the wrong key is
   * refused before its transaction is sent. `connect` hands the same pinned key
   * to a provider-bound twin; the `AbstractSigner` base supplies
   * `populateTransaction` / `sendTransaction` / `estimateGas` / `call` over that
   * provider, exactly as an ethers wallet does, and the signing methods mirror
   * `BaseWallet`'s (its `from` check, its ENS-name resolution) so a consumer
   * cannot tell the two apart.
   */
  class KMSEthereumSigner extends ethers.AbstractSigner {
    constructor(
      private readonly kms: KMSModule,
      private readonly client: KMSClient,
      private readonly key: KMSEthereumSignerKey,
      provider?: ethers.Provider
    ) {
      super(provider)
    }

    /** @inheritdoc */
    async getAddress(): Promise<string> {
      return this.key.address
    }

    /** @inheritdoc */
    connect(provider: ethers.Provider): ethers.Signer {
      return new KMSEthereumSigner(this.kms, this.client, this.key, provider)
    }

    /** @inheritdoc */
    async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
      const request = ethers.copyRequest(tx),
        { region, keyId, address } = this.key,
        // An Addressable or an ENS name becomes an address (a name needs the provider).
        { to, from } = await ethers.resolveProperties({
          to: request.to != null ? ethers.resolveAddress(request.to, this) : null,
          from: request.from != null ? ethers.resolveAddress(request.from, this) : null
        })
      Assert.ok(
        from == null || ethers.getAddress(from) === address,
        `KMSClientProvider: transaction from ${from} is not ${address}, the address of ${keyId} in ${region}`
      )
      // `from` is what the signature proves — never an input of the unsigned transaction.
      const transaction = ethers.Transaction.from({
        ...request,
        to,
        from: null
      } as ethers.TransactionLike<string>)
      transaction.signature = await this.signDigest(
        ethers.getBytes(transaction.unsignedHash)
      )
      return transaction.serialized
    }

    /** @inheritdoc */
    async signMessage(message: string | Uint8Array): Promise<string> {
      const signature = await this.signDigest(
        ethers.getBytes(ethers.hashMessage(message))
      )
      return signature.serialized
    }

    /** @inheritdoc */
    async signTypedData(
      domain: ethers.TypedDataDomain,
      types: Record<string, ethers.TypedDataField[]>,
      value: Record<string, any>
    ): Promise<string> {
      const populated = await ethers.TypedDataEncoder.resolveNames(
          domain,
          types,
          value,
          name => this.resolveTypedDataName(name)
        ),
        signature = await this.signDigest(
          ethers.getBytes(
            ethers.TypedDataEncoder.hash(populated.domain, types, populated.value)
          )
        )
      return signature.serialized
    }

    /**
     * Resolve an ENS name inside typed data through the provider — an ethers
     * wallet's rule: no provider, no names (`AbstractSigner.resolveName`
     * refuses without one), and an unconfigured name is refused by name.
     */
    private async resolveTypedDataName(name: string): Promise<string> {
      const address = await this.resolveName(name)
      Assert.ok(
        address != null,
        `KMSClientProvider: the ENS name ${name} is unconfigured`
      )
      return address
    }

    /**
     * ONE `KMS::Sign` of a 32-byte keccak256 digest, as the ethers `Signature`
     * whose parity recovers to the pinned address — the core every signing
     * method reduces to.
     */
    private async signDigest(digest: Uint8Array): Promise<ethers.Signature> {
      const { region, keyId, address } = this.key
      Assert.strictEqual(
        digest.length,
        Keccak256DigestLength,
        `KMSClientProvider: an Ethereum signer signs a ${Keccak256DigestLength}-byte keccak256 digest, got ${digest.length} bytes`
      )
      const { r, s } = await signEcdsaDigest(
          this.kms,
          this.client,
          region,
          keyId,
          digest
        ),
        signature = RecoveryIds.map(recoveryId =>
          ethers.Signature.from({
            r: ethers.hexlify(r),
            s: ethers.hexlify(s),
            yParity: recoveryId
          })
        ).find(candidate => ethers.recoverAddress(digest, candidate) === address)
      Assert.ok(
        signature != null,
        `KMSClientProvider: could not find a recovery id for the ECDSA signature ${keyId} in ${region} produced — it recovers to neither parity of the pinned address ${address}`
      )
      return signature
    }
  }

  /**
   * An ethers signer whose every signature is a remote `KMS::Sign` of an
   * `ECC_SECG_P256K1` key — the KMS-custody arm of
   * `keyPairUtils.ethereumSigner`: the in-house {@link KMSEthereumSigner},
   * pinned at creation to the address of the key's public point
   * ({@link getPublicKey} — so a key of another spec or usage is refused here,
   * before it signs anything) and signing through the cached regional client,
   * with the same adaptive-retry treatment every other KMS call gets.
   * Connected to `provider` when one is given; without one it signs offline
   * only (messages, typed data, fully specified transactions).
   *
   * @param region - The region the key lives in.
   * @param keyId - Any `KeyId` KMS accepts.
   * @param provider - The provider to connect the signer to.
   * @returns The signer.
   */
  export async function createSigner(
    region: string,
    keyId: string,
    provider?: ethers.Provider
  ): Promise<ethers.Signer> {
    const kms = await importKMSModule(),
      client = await kmsClientForRegion(region),
      { publicKey } = await getPublicKey(region, keyId, KeyType.EM),
      address = ethers.computeAddress(ethers.hexlify(publicKey))
    return new KMSEthereumSigner(kms, client, { region, keyId, address }, provider)
  }

  /**
   * A {@link SolanaSigner} whose every signature is a remote `KMS::Sign` of an
   * `ECC_NIST_EDWARDS25519` key — the KMS-custody arm of
   * `keyPairUtils.solanaSigner`. Each `Sign` is `SigningAlgorithm =
   * ED25519_SHA_512` over `MessageType = RAW` bytes, which is pure Ed25519
   * (RFC 8032) — exactly what Solana verifies — and its 64-byte result is
   * verified against the pinned `publicKey` before it is used, as nodeop's
   * provider does, so a signer wired to the wrong key is refused before its
   * transaction is sent. A transaction is signed over its serialized message
   * (`serializeMessage()` / `message.serialize()`), so the caller sets the fee
   * payer and the recent blockhash first. The regional client carries the
   * same adaptive-retry treatment every other KMS call gets.
   *
   * @param region - The region the key lives in.
   * @param keyId - Any `KeyId` KMS accepts.
   * @param publicKey - The key's 32-byte Ed25519 public key, as adopted from KMS.
   * @returns The signer.
   */
  export async function createSolanaSigner(
    region: string,
    keyId: string,
    publicKey: Uint8Array
  ): Promise<SolanaSigner> {
    Assert.strictEqual(
      publicKey.length,
      Ed25519PublicKeyLength,
      `KMSClientProvider: a Solana signer pins a ${Ed25519PublicKeyLength}-byte Ed25519 public key, got ${publicKey.length} bytes`
    )
    const kms = await importKMSModule(),
      client = await kmsClientForRegion(region),
      signerPublicKey = new SolanaPublicKey(publicKey),
      signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
        Assert.ok(
          message.length > 0 && message.length <= MaxRawMessageLength,
          `KMSClientProvider: KMS signs messages of 1 to ${MaxRawMessageLength} bytes, got ${message.length}`
        )
        const { Signature: signature } = await client.send(
          new kms.SignCommand({
            KeyId: keyId,
            Message: message,
            MessageType: kms.MessageType.RAW,
            SigningAlgorithm: kms.SigningAlgorithmSpec.ED25519_SHA_512
          })
        )
        Assert.ok(
          signature != null && signature.length === Ed25519SignatureLength,
          `KMSClientProvider: ${keyId} in ${region} returned a ${signature?.length ?? 0}-byte Ed25519 signature, expected ${Ed25519SignatureLength}`
        )
        Assert.ok(
          nacl.sign.detached.verify(message, signature, publicKey),
          `KMSClientProvider: ${keyId} in ${region} produced an Ed25519 signature that does not verify against the pinned public key ${signerPublicKey.toBase58()}`
        )
        return signature
      },
      signTransaction = async <T extends Transaction | VersionedTransaction>(
        transaction: T
      ): Promise<T> => {
        await match(transaction as Transaction | VersionedTransaction)
          .with(P.instanceOf(VersionedTransaction), async versioned =>
            versioned.addSignature(
              signerPublicKey,
              await signMessage(versioned.message.serialize())
            )
          )
          .otherwise(async legacy =>
            legacy.addSignature(
              signerPublicKey,
              Buffer.from(await signMessage(legacy.serializeMessage()))
            )
          )
        return transaction
      }
    return {
      publicKey: signerPublicKey,
      signMessage,
      signTransaction,
      signAllTransactions: <T extends Transaction | VersionedTransaction>(
        transactions: T[]
      ): Promise<T[]> => mapSeries(transactions, signTransaction)
    }
  }

  /**
   * A sdk-core {@link SignerProvider} whose every signature is a remote
   * `KMS::Sign` of an `ECC_SECG_P256K1` key — the KMS-custody arm of
   * `keyPairUtils.wireSigner`, what `WireClient.addSigner` registers for a
   * batch operator whose WIRE account key lives in KMS, so its
   * `<account>@active` pushes sign through sdk-core instead of kiod. It
   * mirrors wire-sysio #768's `der_to_wire_k1_signature` (low-S + recovery
   * id): `sign` takes the transaction's 32-byte sha256 signing digest
   * (`Transaction.signingDigest`'s `msgBytes` for a K1 key — a `Uint8Array`,
   * or its hex as `createClassicSigner` also accepts), sends it as
   * `MessageType = DIGEST` under `SigningAlgorithm = ECDSA_SHA_256`, parses
   * the DER `SEQUENCE { INTEGER r, INTEGER s }` KMS returns
   * ({@link secp256k1SignatureFromDer}), normalises `s` to the low half of
   * the group order (the {@link signEcdsaDigest} core it shares with
   * {@link createSigner}), finds the recovery id by recovering each parity
   * against the pinned `publicKey`, and returns the 65-byte raw `[r ‖ s ‖ recid]` —
   * which `Signature.fromRaw(…, KeyType.K1)` packs as `(31 + recid) ‖ r ‖ s`,
   * exactly #768's wire form. A signature that recovers to neither parity is
   * refused naming the key, so a signer wired to the wrong key fails before
   * its transaction is sent. There is no re-sign loop: nodeop's K1
   * `public_key::recover` (libfc `elliptic_secp256k1.cpp`) asserts NO
   * canonical form, so every low-S signature is accepted as is. The regional
   * client carries the same adaptive-retry treatment every other KMS call gets.
   *
   * @param region - The region the key lives in.
   * @param keyId - Any `KeyId` KMS accepts.
   * @param publicKey - The key's K1 public key, as adopted from KMS.
   * @returns The signer.
   */
  export async function createWireSigner(
    region: string,
    keyId: string,
    publicKey: WirePublicKey
  ): Promise<SignerProvider> {
    Assert.strictEqual(
      publicKey.type,
      KeyType.K1,
      `KMSClientProvider: a WIRE signer pins a K1 public key, got ${publicKey.type}`
    )
    const kms = await importKMSModule(),
      client = await kmsClientForRegion(region),
      sign = async (message: string | Uint8Array): Promise<Uint8Array> => {
        const digest = signingDigest(message),
          { r, s } = await signEcdsaDigest(kms, client, region, keyId, digest),
          recoveryId = RecoveryIds.find(candidate =>
            Signature.fromRaw(k1RawSignature(r, s, candidate), KeyType.K1)
              .recoverDigest(digest)
              .equals(publicKey)
          )
        Assert.ok(
          recoveryId != null,
          `KMSClientProvider: could not find a recovery id for the ECDSA signature ${keyId} in ${region} produced — it recovers to neither parity of the pinned public key ${publicKey.toString()}`
        )
        return k1RawSignature(r, s, recoveryId)
      }
    return { pubKey: publicKey, sign }
  }
}
