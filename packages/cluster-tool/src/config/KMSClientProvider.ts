import Assert from "node:assert"
import { ethers } from "ethers"
import {
  PublicKey as SolanaPublicKey,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js"
import { match, P } from "ts-pattern"
import nacl from "tweetnacl"
import { KeyType } from "@wireio/sdk-core"
import { Deferred, getLogger } from "@wireio/shared"
import type { KMSCustodiedKeyType } from "@wireio/cluster-tool-shared"
import type { KeySpec, KMSClient, Tag } from "@aws-sdk/client-kms"
import type { SolanaSigner } from "../types/SolanaSigner.js"
import { mapSeries } from "../utils/asyncUtils.js"

const log = getLogger(__filename)

/** The `@aws-sdk/client-kms` module surface, loaded lazily (type-only static import). */
type KMSModule = typeof import("@aws-sdk/client-kms")
/** The ethers-over-KMS signer module surface, loaded lazily (type-only static import). */
type KMSSignerModule = typeof import("@cuonghx.gu-tech/ethers-aws-kms-signer")

let importKMSModuleDeferred: Deferred<KMSModule> = null
let importKMSSignerModuleDeferred: Deferred<KMSSignerModule> = null

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
 * Load the ethers-over-KMS signer once, the same way: it statically pulls the
 * whole KMS SDK in, so a KEY cluster that never signs through KMS must never
 * load it.
 */
function importKMSSignerModule(): Promise<KMSSignerModule> {
  if (importKMSSignerModuleDeferred === null) {
    importKMSSignerModuleDeferred = new Deferred()
    import("@cuonghx.gu-tech/ethers-aws-kms-signer")
      .then(signerModule => importKMSSignerModuleDeferred.resolve(signerModule))
      .catch(error => {
        const failed = importKMSSignerModuleDeferred
        importKMSSignerModuleDeferred = null
        failed.reject(error)
      })
  }
  return importKMSSignerModuleDeferred.promise
}

/**
 * THE single AWS KMS access surface — the cached SDK accessor + per-region
 * `KMSClient` cache shared by every KMS path: the create path's GENERATION seam
 * (`KeySteps.adoptOrCreateSignatureProviderKey`, which ADOPTS an existing key
 * by alias rather than mint a replacement), the batch-operator key
 * pre-creation, `keyPairUtils.ethereumSigner`, whose KMS arm signs through
 * {@link createSigner}, and `keyPairUtils.solanaSigner`, whose KMS arm signs
 * through {@link createSolanaSigner}.
 *
 * KMS custodies the ethereum (secp256k1, `ECC_SECG_P256K1`) and solana
 * (Ed25519, `ECC_NIST_EDWARDS25519`) keys — `KMSCustodiedKeyTypes` — never a
 * K1 / BLS key: the private key is generated inside KMS and never leaves it —
 * there is no material to fetch, so unlike `SSMClientProvider` nothing here
 * ever returns a secret. There is deliberately NO delete
 * (`ScheduleKeyDeletion`): a key under an alias is the AWS ACCOUNT's durable
 * key identity, which the next `create` adopts — and the funding a pre-launch
 * deployment binds to it is unrecoverable once the key is gone.
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

  /** Length of an uncompressed secp256k1 point (`04 || X || Y`). */
  export const UncompressedPointLength = 65
  /** The SEC1 uncompressed-point marker byte. */
  export const UncompressedPointPrefix = 0x04
  /** Length of a compressed secp256k1 point (`02|03 || X`). */
  export const CompressedPointLength = 33

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
     * The curve-canonical public key bytes: the 33-byte compressed secp256k1
     * point of an EM key, the 32-byte Ed25519 point of an ED key.
     */
    readonly publicKey: Uint8Array
  }

  /**
   * The KMS key spec a custodied curve needs — secp256k1 for an EM key,
   * Ed25519 for an ED key: the ONE map from `KeyType` to key spec, read off
   * the SDK's own roster.
   */
  function signingKeySpec(
    kms: KMSModule,
    keyType: KMSCustodiedKeyType
  ): KeySpec {
    return match(keyType)
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
      .with(KeyType.EM, () => compressedPointFromSpki(spki))
      .with(KeyType.ED, () => ed25519PublicKeyFromSpki(spki))
      .exhaustive()
  }

  /**
   * Fetch a signing key's public identity — `GetPublicKey`, requiring the
   * `SIGN_VERIFY` key of the spec `keyType` needs (secp256k1 for an EM key,
   * Ed25519 for an ED key).
   *
   * @param region - The region the key lives in.
   * @param keyId - Any `KeyId` KMS accepts (alias name, key id, key / alias ARN).
   * @param keyType - The curve the key must sign for.
   * @returns The key's ARN, curve and curve-canonical public key bytes.
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
   * Create a NEW signing key of the spec `keyType` needs (secp256k1 for EM,
   * Ed25519 for ED) and bind `aliasName` to it — the generation backend of a
   * KMS-custodied key. The alias is the key's durable id: `CreateAlias` fails
   * when the name is already bound, so reaching here for an existing alias
   * means the adopt probe and this write disagreed, and the run fails loudly
   * instead of re-pointing the alias.
   *
   * @param region - The region the key lives in.
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
          ...(tags.length > 0 ? { Tags: [...tags] } : {})
        })
      ),
      keyArn = created.KeyMetadata?.Arn
    Assert.ok(
      keyArn != null,
      `KMSClientProvider: CreateKey in ${region} returned no key ARN`
    )
    await client.send(
      new kms.CreateAliasCommand({ AliasName: aliasName, TargetKeyId: keyArn })
    )
    log.info(
      `KMSClientProvider: created ${KeyType[keyType]} key ${keyArn} in ${region} as ${aliasName}`
    )
    return getPublicKey(region, aliasName, keyType)
  }

  /**
   * An ethers signer whose every signature is a remote `KMS::Sign` — the
   * KMS-custody arm of `keyPairUtils.ethereumSigner`. Connected to `provider`
   * when one is given; without one it signs offline only (messages, typed data).
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
    const { AwsKmsSigner } = await importKMSSignerModule()
    return new AwsKmsSigner({ region, keyId }, provider ?? null)
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
}
