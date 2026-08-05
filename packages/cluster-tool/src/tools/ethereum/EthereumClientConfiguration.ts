import Assert from "node:assert"

/** Optional finite limits for one Ethereum signing client. */
export interface EthereumTransactionPolicy {
  readonly max_priority_fee_per_gas_wei: string
  readonly max_fee_per_gas_wei: string
  readonly max_gas_limit: string
  readonly max_total_native_cost_wei: string
}

/** Signing-capable connection fields kept separate from EVM policy metadata. */
export interface EthereumClientConnection {
  readonly client_id: string
  readonly signature_provider_id: string
  readonly rpc_url: string
}

/** One EVM signing client in the unified nodeop Ethereum configuration. */
export interface EthereumClientEntry {
  readonly connection: EthereumClientConnection
  readonly chain_id: number
  readonly transaction_policy?: EthereumTransactionPolicy
}

/** Versioned JSON file consumed by `--outpost-ethereum-client-config-file`. */
export interface EthereumClientConfigurationFile {
  readonly schema_version: number
  readonly clients: readonly EthereumClientEntry[]
}

const CanonicalPositiveDecimal = /^[1-9][0-9]*$/,
  SafeIdentifier = /^[A-Za-z0-9._-]{1,64}$/,
  MaximumUint32 = 2 ** 32 - 1,
  MaximumUint256 = (1n << 256n) - 1n

/** Build and validate the single-client config used by one cluster operator daemon. */
export namespace EthereumClientConfiguration {
  /** Schema revision emitted into every generated configuration file. */
  export const SchemaVersion = 1

  /** Inputs required to generate one EVM signing-client configuration. */
  export interface CreateOptions {
    readonly clientId: string
    readonly signatureProviderId: string
    readonly rpcUrl: string
    readonly chainId: number
    readonly transactionPolicy?: EthereumTransactionPolicy
  }

  /**
   * Create one unified client file; omitted policy means nodeop's maximum-value defaults.
   *
   * @param options - Connection, chain, and optional finite-policy values.
   * @return A validated protobuf-JSON-compatible configuration document.
   */
  export function create(
    options: CreateOptions
  ): EthereumClientConfigurationFile {
    const client: EthereumClientEntry = {
      connection: {
        client_id: options.clientId,
        signature_provider_id: options.signatureProviderId,
        rpc_url: options.rpcUrl
      },
      chain_id: options.chainId,
      ...(options.transactionPolicy == null
        ? {}
        : { transaction_policy: options.transactionPolicy })
    }
    const file: EthereumClientConfigurationFile = {
      schema_version: SchemaVersion,
      clients: [client]
    }
    assertValid(file)
    return file
  }

  /**
   * Assert a generated client file matches nodeop's strict schema and numeric domains.
   *
   * @param file - Generated document to validate before writing it to disk.
   * @return Nothing; invalid documents throw an assertion error.
   */
  export function assertValid(file: EthereumClientConfigurationFile): void {
    Assert.equal(
      file.schema_version,
      SchemaVersion,
      `Ethereum client configuration schema_version must be ${SchemaVersion}`
    )
    Assert.equal(
      file.clients.length,
      1,
      "Operator daemon Ethereum configuration must contain exactly one client"
    )

    const [client] = file.clients
    Assert.ok(
      client.connection != null,
      "Ethereum client connection must be present"
    )
    const { connection } = client
    Assert.match(
      connection.client_id,
      SafeIdentifier,
      "Ethereum client_id must be 1-64 ASCII letters, digits, '.', '_', or '-'"
    )
    Assert.ok(
      connection.signature_provider_id.length > 0,
      "Ethereum signature_provider_id must not be empty"
    )
    const rpcUrl = new URL(connection.rpc_url)
    Assert.ok(
      (rpcUrl.protocol === "http:" || rpcUrl.protocol === "https:") &&
        rpcUrl.hostname.length > 0 &&
        rpcUrl.hash.length === 0,
      "Ethereum rpc_url must use http or https with a host and no fragment"
    )
    Assert.ok(
      Number.isInteger(client.chain_id) &&
        client.chain_id > 0 &&
        client.chain_id <= MaximumUint32,
      "Ethereum chain_id must be a positive uint32"
    )

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
