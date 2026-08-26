import Assert from "node:assert"

/** Finite limits nested in one host-side Ethereum signing client. */
export interface EthereumTransactionPolicy {
  readonly max_priority_fee_per_gas_wei: string
  readonly max_fee_per_gas_wei: string
  readonly max_gas_limit: string
  readonly max_total_native_cost_wei: string
}

/** One signing-capable Ethereum RPC connection. */
export interface EthereumClientConnection {
  readonly client_id: string
  readonly signature_provider_id: string
  readonly rpc_url: string
}

/** One EVM signing client in nodeop's host-side configuration. */
export interface EthereumClientConfiguration {
  readonly connection: EthereumClientConnection
  readonly chain_id: number
  readonly transaction_policy?: EthereumTransactionPolicy
}

/** Versioned ProtoJSON document consumed by `--outpost-ethereum-client-config-file`. */
export interface EthereumClientConfigurationFile {
  readonly schema_version: number
  readonly clients: readonly EthereumClientConfiguration[]
}

const CanonicalPositiveDecimal = /^[1-9][0-9]*$/,
  SafeIdentifier = /^[A-Za-z0-9._-]{1,64}$/,
  MaximumUint32 = 2 ** 32 - 1,
  MaximumUint256 = (1n << 256n) - 1n

/** Construct and validate the host-only Ethereum client ProtoJSON document. */
export namespace EthereumClientConfigurationConfig {
  /** Schema revision defined by `client_config.proto`. */
  export const SchemaVersion = 1

  /**
   * Create one nodeop client configuration.
   *
   * This is intentionally a host-side ProtoJSON factory, not an OPP protocol
   * model. SEC-131 keeps the client configuration outside the shared OPP model
   * bundles consumed by Solidity and Solana.
   *
   * @param clientId - Stable identifier referenced by the Ethereum plugins.
   * @param signatureProviderId - Process-local Ethereum signing-provider id.
   * @param rpcUrl - HTTP(S) Ethereum JSON-RPC endpoint.
   * @param chainId - Positive EVM chain identifier expected from the endpoint.
   * @param transactionPolicy - Optional finite local expenditure policy.
   * @returns A validated document using the protobuf field spelling accepted by nodeop.
   */
  export function create(
    clientId: string,
    signatureProviderId: string,
    rpcUrl: string,
    chainId: number,
    transactionPolicy?: EthereumTransactionPolicy
  ): EthereumClientConfigurationFile {
    const configuration: EthereumClientConfigurationFile = {
      schema_version: SchemaVersion,
      clients: [
        {
          connection: {
            client_id: clientId,
            signature_provider_id: signatureProviderId,
            rpc_url: rpcUrl
          },
          chain_id: chainId,
          ...(transactionPolicy == null
            ? {}
            : { transaction_policy: transactionPolicy })
        }
      ]
    }
    assertValid(configuration)
    return configuration
  }

  /**
   * Validate and return the canonical ProtoJSON value written for nodeop.
   *
   * @param configuration - Host-side configuration to persist.
   * @returns The same validated ProtoJSON document.
   */
  export function toJson(
    configuration: EthereumClientConfigurationFile
  ): EthereumClientConfigurationFile {
    assertValid(configuration)
    return configuration
  }

  /**
   * Assert the local factory's document satisfies the SEC-131 schema boundary.
   *
   * @param configuration - Document to check before persisting it.
   * @returns Nothing; invalid documents throw an assertion error.
   */
  export function assertValid(
    configuration: EthereumClientConfigurationFile
  ): void {
    Assert.equal(
      configuration.schema_version,
      SchemaVersion,
      `Ethereum client configuration schema_version must be ${SchemaVersion}`
    )
    Assert.equal(
      configuration.clients.length,
      1,
      "Operator daemon Ethereum configuration must contain exactly one client"
    )

    const [client] = configuration.clients
    Assert.ok(client.connection != null, "Ethereum client connection must be present")
    Assert.match(
      client.connection.client_id,
      SafeIdentifier,
      "Ethereum client_id must be 1-64 ASCII letters, digits, '.', '_', or '-'"
    )
    Assert.ok(
      client.connection.signature_provider_id.length > 0,
      "Ethereum signature_provider_id must not be empty"
    )
    const rpcUrl = new URL(client.connection.rpc_url)
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

    if (client.transaction_policy != null) {
      assertTransactionPolicy(client.transaction_policy)
    }
  }

  /**
   * Assert that a finite policy uses canonical uint256 decimal fields and a
   * valid EIP-1559 fee relationship.
   *
   * @param policy - Transaction policy nested in a client configuration.
   * @returns Nothing; invalid policies throw an assertion error.
   */
  export function assertTransactionPolicy(
    policy: EthereumTransactionPolicy
  ): void {
    const maximumPriorityFeePerGas = positiveUint(
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
