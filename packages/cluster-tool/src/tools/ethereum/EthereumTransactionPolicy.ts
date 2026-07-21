import Assert from "node:assert"

/** One SEC-131 Ethereum signing-client transaction policy. */
export interface EthereumTransactionPolicy {
  /** Stable client id also used by `--outpost-ethereum-client`. */
  readonly client_id: string
  /** Canonical positive decimal EVM chain id. */
  readonly chain_id: string
  /** Maximum EIP-1559 priority fee per gas, in wei. */
  readonly max_priority_fee_per_gas_wei: string
  /** Maximum EIP-1559 fee per gas, in wei. */
  readonly max_fee_per_gas_wei: string
  /** Maximum final gas limit after nodeop applies its estimation headroom. */
  readonly max_gas_limit: string
  /** Maximum `gas limit × maximum fee per gas + transaction value`, in wei. */
  readonly max_total_native_cost_wei: string
}

/** Versioned JSON file consumed by SEC-131's Ethereum outpost client plugin. */
export interface EthereumTransactionPolicyFile {
  /** SEC-131 policy schema version. */
  readonly version: number
  /** Policies keyed by the matching Ethereum outpost client id. */
  readonly policies: readonly EthereumTransactionPolicy[]
}

const CanonicalPositiveDecimal = /^[1-9][0-9]*$/,
  SafeClientIdentifier = /^[A-Za-z0-9._-]{1,64}$/,
  MaximumUint32 = (1n << 32n) - 1n,
  MaximumUint256 = (1n << 256n) - 1n

/**
 * Anvil-only SEC-131 transaction limits for generated cluster operator daemons.
 * These development-cluster bounds are not production recommendations.
 */
export namespace AnvilEthereumTransactionPolicy {
  /** SEC-131 JSON policy schema version. */
  export const SchemaVersion = 1
  /** Anvil priority-fee cap: 2 gwei. */
  export const MaximumPriorityFeePerGasWei = 2_000_000_000n
  /** Anvil maximum-fee cap: 100 gwei, leaving ample local EIP-1559 base-fee headroom. */
  export const MaximumFeePerGasWei = 100_000_000_000n
  /** Anvil final gas-limit cap for Ethereum OPP delivery and underwriter transactions. */
  export const MaximumGasLimit = 2_000_000n
  /**
   * Anvil total native-cost cap: 0.25 ETH. After the full 0.2 ETH
   * `MaximumGasLimit × MaximumFeePerGasWei` gas bound, 0.05 ETH remains for
   * transaction value.
   */
  export const MaximumTotalNativeCostWei = 250_000_000_000_000_000n

  /**
   * Create the single-client policy file used by generated Anvil operator daemons.
   *
   * @param clientId - Stable id used by the matching Ethereum client argument.
   * @param chainId - Positive uint32 Anvil chain id.
   * @returns A validated SEC-131 policy file with canonical decimal strings.
   */
  export function create(
    clientId: string,
    chainId: number
  ): EthereumTransactionPolicyFile {
    const file: EthereumTransactionPolicyFile = {
      version: SchemaVersion,
      policies: [
        {
          client_id: clientId,
          chain_id: String(chainId),
          max_priority_fee_per_gas_wei: MaximumPriorityFeePerGasWei.toString(),
          max_fee_per_gas_wei: MaximumFeePerGasWei.toString(),
          max_gas_limit: MaximumGasLimit.toString(),
          max_total_native_cost_wei: MaximumTotalNativeCostWei.toString()
        }
      ]
    }
    assertValid(file)
    return file
  }

  /**
   * Assert a generated policy file is canonical and satisfies SEC-131 plus
   * cluster-tool's full maximum-cost relationship.
   *
   * @param file - Policy file to validate before it is written or referenced.
   * @throws An assertion error naming the invalid policy field or relationship.
   */
  export function assertValid(file: EthereumTransactionPolicyFile): void {
    Assert.equal(
      file.version,
      SchemaVersion,
      `Ethereum transaction policy version must be ${SchemaVersion}`
    )
    Assert.equal(
      file.policies.length,
      1,
      "Anvil Ethereum transaction policy must contain exactly one client policy"
    )

    const [policy] = file.policies
    Assert.match(
      policy.client_id,
      SafeClientIdentifier,
      "Ethereum transaction policy client_id must be 1-64 ASCII letters, digits, '.', '_', or '-'"
    )
    const chainId = positiveUint256(policy.chain_id, "chain_id")
    Assert.ok(
      chainId <= MaximumUint32,
      "Ethereum transaction policy chain_id must fit uint32"
    )

    const maximumPriorityFeePerGas = positiveUint256(
        policy.max_priority_fee_per_gas_wei,
        "max_priority_fee_per_gas_wei"
      ),
      maximumFeePerGas = positiveUint256(
        policy.max_fee_per_gas_wei,
        "max_fee_per_gas_wei"
      ),
      maximumGasLimit = positiveUint256(policy.max_gas_limit, "max_gas_limit"),
      maximumTotalNativeCost = positiveUint256(
        policy.max_total_native_cost_wei,
        "max_total_native_cost_wei"
      )

    Assert.ok(
      maximumPriorityFeePerGas <= maximumFeePerGas,
      "Ethereum transaction policy priority-fee cap must not exceed maximum-fee cap"
    )
    Assert.ok(
      maximumTotalNativeCost >= maximumGasLimit * maximumFeePerGas,
      "Ethereum transaction policy total-cost cap must cover gas-limit × maximum-fee caps"
    )
  }
}

/** Parse one SEC-131 canonical positive uint256 decimal field. */
function positiveUint256(value: string, field: string): bigint {
  Assert.match(
    value,
    CanonicalPositiveDecimal,
    `Ethereum transaction policy ${field} must be a canonical positive decimal string`
  )
  const parsed = BigInt(value)
  Assert.ok(
    parsed <= MaximumUint256,
    `Ethereum transaction policy ${field} must fit uint256`
  )
  return parsed
}
