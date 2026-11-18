import Assert from "node:assert"

import {
  EthereumClientConfigurationConfig,
  type EthereumTransactionPolicy
} from "./EthereumClientConfigurationConfig.js"

/** Finite SEC-131 transaction limits for Anvil-backed operator daemons. */
export namespace AnvilEthereumTransactionPolicyConfig {
  /** Maximum EIP-1559 priority fee per gas in wei: 2 gwei. */
  export const MaximumPriorityFeePerGasWei = "2000000000"
  /** Maximum EIP-1559 fee per gas in wei: 100 gwei. */
  export const MaximumFeePerGasWei = "100000000000"
  /** EIP-7825's final gas ceiling, including nodeop's 20% estimate buffer. */
  export const MaximumGasLimit = "16777216"
  /** Maximum native cost in wei: 1.7 ETH, covering the full gas/fee bounds. */
  export const MaximumTotalNativeCostWei = "1700000000000000000"

  /**
   * Create the finite policy embedded in each local Anvil client.
   * These limits are for local development and test clusters only; they are not
   * production policy recommendations.
   *
   * @returns A validated policy using SEC-131's protobuf field spelling.
   */
  export function create(): EthereumTransactionPolicy {
    const policy: EthereumTransactionPolicy = {
      max_priority_fee_per_gas_wei: MaximumPriorityFeePerGasWei,
      max_fee_per_gas_wei: MaximumFeePerGasWei,
      max_gas_limit: MaximumGasLimit,
      max_total_native_cost_wei: MaximumTotalNativeCostWei
    }
    EthereumClientConfigurationConfig.assertTransactionPolicy(policy)
    Assert.ok(
      BigInt(policy.max_total_native_cost_wei) >=
        BigInt(policy.max_gas_limit) * BigInt(policy.max_fee_per_gas_wei),
      "Anvil Ethereum transaction policy total-cost cap must cover gas-limit × maximum-fee caps"
    )
    return policy
  }
}
