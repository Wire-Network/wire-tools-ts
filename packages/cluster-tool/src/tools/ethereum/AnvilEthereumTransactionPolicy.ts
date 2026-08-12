import Assert from "node:assert"

import {
  EthereumClientConfiguration,
  type EthereumTransactionPolicy
} from "./EthereumClientConfiguration.js"

/**
 * Finite SEC-131 transaction limits for Anvil-backed operator daemons.
 * These limits are for local development and test clusters only; they are not
 * production policy recommendations.
 */
export namespace AnvilEthereumTransactionPolicy {
  /** Maximum EIP-1559 priority fee per gas in wei: 2 gwei. */
  export const MaximumPriorityFeePerGasWei = "2000000000"
  /** Maximum EIP-1559 fee per gas in wei: 100 gwei. */
  export const MaximumFeePerGasWei = "100000000000"
  /** Maximum final gas limit after nodeop's 20% estimate buffer. */
  export const MaximumGasLimit = "6000000"
  /** Maximum native cost in wei: 0.7 ETH. */
  export const MaximumTotalNativeCostWei = "700000000000000000"

  /**
   * Create the finite policy embedded in each local Anvil Ethereum client.
   *
   * @returns A validated finite policy using canonical unsigned-decimal fields.
   */
  export function create(): EthereumTransactionPolicy {
    const policy: EthereumTransactionPolicy = {
      max_priority_fee_per_gas_wei: MaximumPriorityFeePerGasWei,
      max_fee_per_gas_wei: MaximumFeePerGasWei,
      max_gas_limit: MaximumGasLimit,
      max_total_native_cost_wei: MaximumTotalNativeCostWei
    }
    EthereumClientConfiguration.assertTransactionPolicy(policy)
    Assert.ok(
      BigInt(policy.max_total_native_cost_wei) >=
        BigInt(policy.max_gas_limit) * BigInt(policy.max_fee_per_gas_wei),
      "Anvil Ethereum transaction policy total-cost cap must cover gas-limit × maximum-fee caps"
    )
    return policy
  }
}
