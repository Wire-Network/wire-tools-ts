import Assert from "node:assert"
import { ethers } from "ethers"
import { match, P } from "ts-pattern"
import { Deferred, getLogger } from "@wireio/shared"
import type { KMSClient, Tag } from "@aws-sdk/client-kms"

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
 * pre-creation, and `keyPairUtils.ethereumSigner`, whose KMS arm signs through
 * {@link createSigner}.
 *
 * KMS custodies secp256k1 / ethereum keys ONLY (`KMSCustodiedKeyTypes`): the
 * private key is generated inside KMS and never leaves it — there is no
 * material to fetch, so unlike `SSMClientProvider` nothing here ever returns a
 * secret. There is deliberately NO delete (`ScheduleKeyDeletion`): a key under
 * an alias is the AWS ACCOUNT's durable key identity, which the next `create`
 * adopts — and the funding a pre-launch deployment binds to it is unrecoverable
 * once the key is gone.
 */
export namespace KMSClientProvider {
  /** The KMS key spec of an ethereum signing key — secp256k1. */
  export const SigningKeySpec = "ECC_SECG_P256K1"
  /** The KMS key usage of a signing key. */
  export const SigningKeyUsage = "SIGN_VERIFY"

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

  /** A KMS signing key's PUBLIC identity — everything an EM pair needs besides its custody ref. */
  export interface PublicKey {
    /** The key's ARN, as KMS reports it (the durable identity behind the alias). */
    readonly keyArn: string
    /** The 33-byte compressed secp256k1 point. */
    readonly compressed: Uint8Array
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
   * Fetch a signing key's public identity — `GetPublicKey`, requiring the
   * secp256k1 `SIGN_VERIFY` spec an ethereum key needs.
   *
   * @param region - The region the key lives in.
   * @param keyId - Any `KeyId` KMS accepts (alias name, key id, key / alias ARN).
   * @returns The key's ARN and compressed public point.
   */
  export async function getPublicKey(
    region: string,
    keyId: string
  ): Promise<PublicKey> {
    const { GetPublicKeyCommand } = await importKMSModule()
    const client = await kmsClientForRegion(region)
    const response = await client.send(new GetPublicKeyCommand({ KeyId: keyId }))
    Assert.ok(
      response.PublicKey != null && response.KeyId != null,
      `KMSClientProvider: GetPublicKey for ${keyId} in ${region} returned no public key`
    )
    Assert.strictEqual(
      response.KeySpec,
      SigningKeySpec,
      `KMSClientProvider: ${keyId} in ${region} is a ${response.KeySpec} key, not ${SigningKeySpec}`
    )
    Assert.strictEqual(
      response.KeyUsage,
      SigningKeyUsage,
      `KMSClientProvider: ${keyId} in ${region} is a ${response.KeyUsage} key, not ${SigningKeyUsage}`
    )
    return {
      keyArn: response.KeyId,
      compressed: compressedPointFromSpki(response.PublicKey)
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
   * @returns The public identity, or nothing when the key does not exist.
   */
  export async function tryGetPublicKey(
    region: string,
    keyId: string
  ): Promise<PublicKey> {
    try {
      return await getPublicKey(region, keyId)
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
   * Create a NEW secp256k1 signing key and bind `aliasName` to it — the
   * generation backend of a KMS-custodied EM key. The alias is the key's
   * durable id: `CreateAlias` fails when the name is already bound, so reaching
   * here for an existing alias means the adopt probe and this write disagreed,
   * and the run fails loudly instead of re-pointing the alias.
   *
   * @param region - The region the key lives in.
   * @param aliasName - The alias to bind (`alias/…`).
   * @param description - The key's KMS description (what it is for).
   * @param tags - Tags applied at creation (omit for none).
   * @returns The new key's public identity.
   */
  export async function createKey(
    region: string,
    aliasName: string,
    description: string,
    tags: readonly Tag[] = []
  ): Promise<PublicKey> {
    assertAliasName(aliasName)
    const { CreateKeyCommand, CreateAliasCommand } = await importKMSModule()
    const client = await kmsClientForRegion(region)
    const created = await client.send(
      new CreateKeyCommand({
        KeySpec: SigningKeySpec,
        KeyUsage: SigningKeyUsage,
        Description: description,
        ...(tags.length > 0 ? { Tags: [...tags] } : {})
      })
    )
    const keyArn = created.KeyMetadata?.Arn
    Assert.ok(
      keyArn != null,
      `KMSClientProvider: CreateKey in ${region} returned no key ARN`
    )
    await client.send(
      new CreateAliasCommand({ AliasName: aliasName, TargetKeyId: keyArn })
    )
    log.info(`KMSClientProvider: created ${keyArn} in ${region} as ${aliasName}`)
    return getPublicKey(region, aliasName)
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
}
