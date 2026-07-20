import Assert from "node:assert"
import { Deferred } from "@wireio/shared"
import type { SSMClient } from "@aws-sdk/client-ssm"

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
 * (get), the `PublishSignatureProviderKeys` steps (put), and
 * `ClusterManager.destroy` (delete). Never echoes a parameter VALUE (callers log
 * only the id + reason).
 */
export namespace SSMClientProvider {
  /** SSM parameter `Type` that carries an encrypted (decryptable) value. */
  const SecureStringType = "SecureString"

  /** Per-region `SSMClient` cache (mirrors the C++ `region_client_cache`). */
  const ssmClientsByRegion = new Map<string, SSMClient>()

  /** Get-or-create the cached `SSMClient` for `region`. */
  async function ssmClientForRegion(region: string): Promise<SSMClient> {
    const cached = ssmClientsByRegion.get(region)
    if (cached != null) return cached
    const { SSMClient } = await importSSMModule()
    const client = new SSMClient({ region })
    ssmClientsByRegion.set(region, client)
    return client
  }

  /**
   * Fetch a `SecureString` parameter's value — `GetParameter` with decryption,
   * require a `SecureString`, trim, reject empty. The value is NEVER logged.
   *
   * @param region - AWS region.
   * @param secretId - The parameter name/id.
   * @returns The decrypted, trimmed value.
   */
  export async function getParameter(
    region: string,
    secretId: string
  ): Promise<string> {
    const { GetParameterCommand } = await importSSMModule()
    const client = await ssmClientForRegion(region)
    const response = await client.send(
      new GetParameterCommand({ Name: secretId, WithDecryption: true })
    )
    const parameter = response.Parameter
    Assert.ok(
      parameter != null,
      `SSMClientProvider: parameter ${secretId} not found in ${region}`
    )
    Assert.ok(
      parameter.Type == null || parameter.Type === SecureStringType,
      `SSMClientProvider: parameter ${secretId} must be a SecureString (got ${parameter.Type})`
    )
    const value = (parameter.Value ?? "").trim()
    Assert.ok(
      value.length > 0,
      `SSMClientProvider: parameter ${secretId} is empty`
    )
    return value
  }

  /**
   * Publish `value` as a `SecureString` parameter (overwriting). The value is
   * NEVER logged.
   *
   * @param region - AWS region.
   * @param secretId - The parameter name/id.
   * @param value - The secret value to store.
   */
  export async function putParameter(
    region: string,
    secretId: string,
    value: string
  ): Promise<void> {
    const { PutParameterCommand } = await importSSMModule()
    const client = await ssmClientForRegion(region)
    await client.send(
      new PutParameterCommand({
        Name: secretId,
        Value: value,
        Type: SecureStringType,
        Overwrite: true
      })
    )
  }

  /**
   * Delete a parameter (best-effort — the caller guards + logs; never blocks).
   *
   * @param region - AWS region.
   * @param secretId - The parameter name/id.
   */
  export async function deleteParameter(
    region: string,
    secretId: string
  ): Promise<void> {
    const { DeleteParameterCommand } = await importSSMModule()
    const client = await ssmClientForRegion(region)
    await client.send(new DeleteParameterCommand({ Name: secretId }))
  }
}
