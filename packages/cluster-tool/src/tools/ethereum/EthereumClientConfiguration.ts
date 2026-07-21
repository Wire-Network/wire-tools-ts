import Assert from "node:assert"

/** Optional finite limits for one Ethereum signing client. */
export interface EthereumTransactionPolicy {
  readonly max_priority_fee_per_gas_wei: string
  readonly max_fee_per_gas_wei: string
  readonly max_gas_limit: string
  readonly max_total_native_cost_wei: string
}

/** One connection in the unified nodeop Ethereum client configuration. */
export interface EthereumClientEntry {
  readonly client_id: string
  readonly signature_provider_id: string
  readonly rpc_url: string
  readonly chain_id: string
  readonly transaction_policy?: EthereumTransactionPolicy
}

/** Versioned JSON file consumed by `--outpost-ethereum-client-config-file`. */
export interface EthereumClientConfigurationFile {
  readonly version: number
  readonly clients: readonly EthereumClientEntry[]
}

const CanonicalPositiveDecimal = /^[1-9][0-9]*$/,
  SafeIdentifier = /^[A-Za-z0-9._-]{1,64}$/,
  MaximumUint32 = (1n << 32n) - 1n,
  MaximumUint256 = (1n << 256n) - 1n

/** Build and validate the single-client config used by one cluster operator daemon. */
export namespace EthereumClientConfiguration {
  export const SchemaVersion = 1

  export interface CreateOptions {
    readonly clientId: string
    readonly signatureProviderId: string
    readonly rpcUrl: string
    readonly chainId: number
    readonly transactionPolicy?: EthereumTransactionPolicy
  }

  /** Create one unified client file; omitted policy means nodeop's maximum-value defaults. */
  export function create(
    options: CreateOptions
  ): EthereumClientConfigurationFile {
    const client: EthereumClientEntry = {
      client_id: options.clientId,
      signature_provider_id: options.signatureProviderId,
      rpc_url: options.rpcUrl,
      chain_id: String(options.chainId),
      ...(options.transactionPolicy == null
        ? {}
        : { transaction_policy: options.transactionPolicy })
    }
    const file: EthereumClientConfigurationFile = {
      version: SchemaVersion,
      clients: [client]
    }
    assertValid(file)
    return file
  }

  /** Assert a generated client file matches nodeop's strict schema and numeric domains. */
  export function assertValid(file: EthereumClientConfigurationFile): void {
    Assert.equal(
      file.version,
      SchemaVersion,
      `Ethereum client configuration version must be ${SchemaVersion}`
    )
    Assert.equal(
      file.clients.length,
      1,
      "Operator daemon Ethereum configuration must contain exactly one client"
    )

    const [client] = file.clients
    Assert.match(
      client.client_id,
      SafeIdentifier,
      "Ethereum client_id must be 1-64 ASCII letters, digits, '.', '_', or '-'"
    )
    Assert.ok(
      client.signature_provider_id.length > 0,
      "Ethereum signature_provider_id must not be empty"
    )
    const rpcUrl = new URL(client.rpc_url)
    Assert.ok(
      rpcUrl.protocol === "http:" || rpcUrl.protocol === "https:",
      "Ethereum rpc_url must use http or https"
    )
    const chainId = positiveUint(client.chain_id, "chain_id", MaximumUint32)

    if (client.transaction_policy == null) return
    const policy = client.transaction_policy,
      maximumPriorityFeePerGas = positiveUint(
        policy.max_priority_fee_per_gas_wei,
        "max_priority_fee_per_gas_wei",
        MaximumUint256
      ),
      maximumFeePerGas = positiveUint(
        policy.max_fee_per_gas_wei,
        "max_fee_per_gas_wei",
        MaximumUint256
      )
    positiveUint(policy.max_gas_limit, "max_gas_limit", MaximumUint256)
    positiveUint(
      policy.max_total_native_cost_wei,
      "max_total_native_cost_wei",
      MaximumUint256
    )
    Assert.ok(chainId > 0n)
    Assert.ok(
      maximumPriorityFeePerGas <= maximumFeePerGas,
      "Ethereum priority-fee cap must not exceed maximum-fee cap"
    )
  }
}

/** Parse one canonical positive unsigned decimal bounded by `maximum`. */
function positiveUint(value: string, field: string, maximum: bigint): bigint {
  Assert.match(
    value,
    CanonicalPositiveDecimal,
    `Ethereum ${field} must be a canonical positive decimal string`
  )
  const parsed = BigInt(value)
  Assert.ok(parsed <= maximum, `Ethereum ${field} exceeds its supported domain`)
  return parsed
}
