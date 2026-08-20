import Assert from "node:assert"
import { match, P } from "ts-pattern"
import { Deferred, getLogger } from "@wireio/shared"
import type { SSMClient, Tag } from "@aws-sdk/client-ssm"
import { eachSeries } from "../utils/asyncUtils.js"

const log = getLogger(__filename)

/** The `@aws-sdk/client-ssm` module surface, loaded lazily (type-only static import). */
type SSMModule = typeof import("@aws-sdk/client-ssm")

let importSSMModuleDeferred: Deferred<SSMModule> = null

/**
 * Load `@aws-sdk/client-ssm` once through a single cached accessor
 * (`dynamic-import-esm-only-deps.md`) — the SDK is heavy and only the SSM paths
 * need it. Cache assigned SYNCHRONOUSLY (before the first `await`) so concurrent
 * callers share the one in-flight import.
 */
function importSSMModule(): Promise<SSMModule> {
  if (importSSMModuleDeferred === null) {
    importSSMModuleDeferred = new Deferred()
    import("@aws-sdk/client-ssm")
      .then(ssmModule => importSSMModuleDeferred.resolve(ssmModule))
      .catch(error => {
        const failed = importSSMModuleDeferred
        importSSMModuleDeferred = null
        failed.reject(error)
      })
  }
  return importSSMModuleDeferred.promise
}

/**
 * THE single AWS SSM access surface — the cached SDK accessor + per-region
 * `SSMClient` cache shared by every SSM path: `SignatureProviderConfigProvider`
 * (get), the create path's GENERATION seams (`KeySteps.runGenerateNodeKeys` /
 * `WireOperatorProvisioningTool.runIdentityMaterialization`, which ADOPT an
 * existing parameter rather than regenerate its key), and the
 * `Publish{Node,Operator}SignatureProviderKeys` phases' steps (put).
 *
 * There is deliberately NO delete: a published parameter is the AWS ACCOUNT's
 * durable key identity, which the next `create` adopts — `ClusterManager.destroy`
 * logs the ids it retains and removes nothing. Never echoes a parameter VALUE
 * (callers log only the id + reason).
 */
export namespace SSMClientProvider {
  /** SSM parameter `Type` that carries an encrypted (decryptable) value. */
  const SecureStringType = "SecureString"

  /**
   * The `name` AWS SSM gives the error for a parameter id that has never been
   * published. It is the ONLY failure `tryGetParameter` treats as "nothing to
   * adopt" — every other one propagates.
   */
  const ParameterNotFoundErrorName = "ParameterNotFound"

  /**
   * The region value meaning "resolve it from the ambient AWS environment
   * chain" (env vars → shared config → IMDS) rather than pinning one. Mirrors
   * the depot plugin's region-less `SSM:<parameter-name>` spec, whose
   * `region_client_cache` treats an empty region the same way. Used by every
   * read of a region-less `SignatureProviderSSMConfig`: that config's
   * `awsRegions` is informational, so no single region may be picked from it.
   */
  export const AmbientRegion = ""

  /** How the ambient region is named in diagnostics (it has no region name). */
  const AmbientRegionLabel = "the ambient AWS region"

  /**
   * SDK retry mode for every SSM client. `adaptive` layers a client-side rate
   * limiter over `standard`'s jittered backoff, so a throttled burst slows the
   * CLIENT rather than each call retrying blindly against the same limit.
   */
  const AdaptiveRetryMode = "adaptive"

  /**
   * Attempts per SSM call. Raised well above the SDK default of 3: key
   * publication is a long burst against Parameter Store's shared throughput,
   * and a throttle mid-run aborts the whole cluster build after the platform
   * has already been built.
   */
  const MaxRetryAttempts = 10

  /** Per-region `SSMClient` cache (mirrors the C++ `region_client_cache`). */
  const ssmClientsByRegion = new Map<string, SSMClient>()

  /** One region's answer when probing a secret id across the replication set. */
  interface RegionParameter {
    /** The region the value came from. */
    region: string
    /** The decrypted value that region holds. */
    value: string
  }

  /** Human label for `region` in diagnostics. */
  function regionLabel(region: string): string {
    return region === AmbientRegion ? AmbientRegionLabel : region
  }

  /** Get-or-create the cached `SSMClient` for `region`. */
  async function ssmClientForRegion(region: string): Promise<SSMClient> {
    const cached = ssmClientsByRegion.get(region)
    if (cached != null) return cached
    const { SSMClient } = await importSSMModule()
    // An AmbientRegion client OMITS `region` entirely so the SDK's own resolver
    // chain supplies it — passing "" would be a bad endpoint.
    const client = new SSMClient({
      ...(region === AmbientRegion ? {} : { region }),
      // Publication emits ONE PutParameter per (identity, keyType, region) with
      // no pacing — a 21-producer / 21-batch-operator cluster is >100 calls
      // back-to-back, which Parameter Store throttles ("Rate exceeded"). The
      // SDK default (`standard`, 3 attempts) retries each call in isolation and
      // still loses a sustained burst; ADAPTIVE additionally maintains a
      // client-side rate limiter that slows the whole client in response to
      // throttling, which is what a burst needs.
      retryMode: AdaptiveRetryMode,
      maxAttempts: MaxRetryAttempts
    })
    ssmClientsByRegion.set(region, client)
    return client
  }

  /**
   * Whether `error` is SSM's `ParameterNotFound` (the id does not exist yet).
   * Matched by NAME, not by class: `ParameterNotFound` reaches here through the
   * lazily-imported SDK, so an `instanceof` against a statically-imported class
   * would be a second module instance.
   */
  function isParameterNotFound(error: unknown): boolean {
    return match(error)
      .with(P.instanceOf(Error), ({ name }) => name === ParameterNotFoundErrorName)
      .otherwise(() => false)
  }

  /**
   * Fetch a `SecureString` parameter's value — `GetParameter` with decryption,
   * require a `SecureString`, trim, reject empty. The value is NEVER logged.
   *
   * @param region - AWS region, or {@link AmbientRegion} to resolve it from the
   *   AWS environment chain (the region-less read).
   * @param secretId - The parameter name/id.
   * @returns The decrypted, trimmed value.
   */
  export async function getParameter(region: string, secretId: string): Promise<string> {
    const { GetParameterCommand } = await importSSMModule()
    const client = await ssmClientForRegion(region)
    const response = await client.send(new GetParameterCommand({ Name: secretId, WithDecryption: true }))
    const parameter = response.Parameter
    Assert.ok(parameter != null, `SSMClientProvider: parameter ${secretId} not found in ${regionLabel(region)}`)
    Assert.ok(
      parameter.Type == null || parameter.Type === SecureStringType,
      `SSMClientProvider: parameter ${secretId} must be a SecureString (got ${parameter.Type})`
    )
    const value = (parameter.Value ?? "").trim()
    Assert.ok(value.length > 0, `SSMClientProvider: parameter ${secretId} is empty`)
    return value
  }

  /**
   * Fetch a parameter that MAY NOT EXIST — the adopt-existing probe. Returns
   * the decrypted value when the id is published, and nothing when SSM reports
   * `ParameterNotFound`. The value is NEVER logged.
   *
   * This primitive exists because {@link getParameter} cannot express absence:
   * it hard-asserts a non-null `Parameter`, so a `!= null` check against its
   * result can never be false — a missing id throws there, and a caller that
   * wants "generate when absent" would have to swallow every failure to see it.
   *
   * ONLY `ParameterNotFound` is treated as absence, matched BY ERROR NAME.
   * Every other failure — `AccessDeniedException`, a throttle, a KMS decrypt
   * failure, a wrong-`Type` parameter — propagates: mistaking one of those for
   * "nothing to adopt" would silently regenerate a key the AWS account already
   * owns and orphan every consumer holding the old one.
   *
   * @param region - AWS region, or {@link AmbientRegion} for the region-less read.
   * @param secretId - The parameter name/id.
   * @returns The decrypted, trimmed value, or nothing when the id is unpublished.
   */
  export async function tryGetParameter(region: string, secretId: string): Promise<string> {
    try {
      return await getParameter(region, secretId)
    } catch (error) {
      if (!isParameterNotFound(error)) throw error
      log.debug(
        `SSMClientProvider: ${secretId} is not published in ${regionLabel(region)} — nothing to adopt (${
          error instanceof Error ? error.message : String(error)
        })`
      )
      return null
    }
  }

  /**
   * Probe `regions` IN ORDER for `secretId` and return the ONE value they agree
   * on, or nothing when no region holds it — the multi-region adopt read.
   *
   * Every region that HAS the parameter must carry the SAME value. A split (say
   * a rotation that landed in `us-east-1` but not `eu-west-1`) would otherwise
   * resolve to whichever region happened to be probed first and silently adopt
   * the wrong key, so a divergence hard-fails NAMING the regions instead.
   *
   * @param regions - Every region the parameter is replicated to.
   * @param secretId - The parameter name/id.
   * @returns The agreed value, or nothing when the id is unpublished everywhere.
   * @throws If two regions hold DIFFERENT values for `secretId`.
   */
  export async function getParameterAcrossRegions(regions: readonly string[], secretId: string): Promise<string> {
    const present: RegionParameter[] = []
    await eachSeries(regions, async region => {
      const value = await tryGetParameter(region, secretId)
      if (value != null) present.push({ region, value })
    })
    if (present.length === 0) return null
    const [first, ...rest] = present,
      divergent = rest.filter(entry => entry.value !== first.value)
    Assert.ok(
      divergent.length === 0,
      `SSMClientProvider: parameter ${secretId} DIVERGES across regions — ${regionLabel(
        first.region
      )} disagrees with ${divergent
        .map(entry => regionLabel(entry.region))
        .join(", ")}; reconcile them before creating (adopting either value would orphan the other region's consumers)`
    )
    return first.value
  }

  /**
   * Publish `value` as a NEW `SecureString` parameter. The value is NEVER
   * logged.
   *
   * `Overwrite` is deliberately FALSE: an existing parameter is the AWS
   * account's durable key identity, which the create path ADOPTS
   * ({@link tryGetParameter}) rather than replaces — so reaching a put for an
   * id that already exists means the adopt probe and this write disagreed, and
   * the run must fail loudly instead of rotating a key out from under every
   * consumer already holding it. `Tags` is only accepted on a non-overwriting
   * put, which is why the tags ride this call rather than a follow-up
   * `AddTagsToResource`.
   *
   * @param region - AWS region.
   * @param secretId - The parameter name/id.
   * @param value - The secret value to store.
   * @param tags - Tags applied at creation (omit for none).
   */
  export async function putParameter(
    region: string,
    secretId: string,
    value: string,
    tags: readonly Tag[] = []
  ): Promise<void> {
    const { PutParameterCommand } = await importSSMModule()
    const client = await ssmClientForRegion(region)
    await client.send(
      new PutParameterCommand({
        Name: secretId,
        Value: value,
        Type: SecureStringType,
        Overwrite: false,
        ...(tags.length > 0 ? { Tags: [...tags] } : {})
      })
    )
  }
}
