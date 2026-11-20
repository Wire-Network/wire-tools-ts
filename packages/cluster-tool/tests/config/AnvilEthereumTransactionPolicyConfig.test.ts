import { AnvilEthereumTransactionPolicyConfig } from "@wireio/cluster-tool/config"

/** ETH-259's emission budget, leaving room for the generic client's buffer. */
const EmissionGasBudget = 13_500_000n,
  NodeopGasEstimateBufferNumerator = 6n,
  NodeopGasEstimateBufferDenominator = 5n

describe("AnvilEthereumTransactionPolicyConfig", () => {
  it("defines the finite local SEC-131 limits in ProtoJSON fields", () => {
    expect(AnvilEthereumTransactionPolicyConfig.create()).toEqual({
      max_priority_fee_per_gas_wei: "2000000000",
      max_fee_per_gas_wei: "100000000000",
      max_gas_limit: "16777216",
      max_total_native_cost_wei: "1700000000000000000"
    })
  })

  it("keeps the full fee, gas, and total-cost cap relationship valid", () => {
    const policy = AnvilEthereumTransactionPolicyConfig.create()
    expect(BigInt(policy.max_priority_fee_per_gas_wei)).toBeLessThanOrEqual(
      BigInt(policy.max_fee_per_gas_wei)
    )
    expect(BigInt(policy.max_total_native_cost_wei)).toBeGreaterThanOrEqual(
      BigInt(policy.max_gas_limit) * BigInt(policy.max_fee_per_gas_wei)
    )
  })

  it("leaves 20% headroom above the bounded emission budget", () => {
    const bufferedGasLimit =
      (EmissionGasBudget * NodeopGasEstimateBufferNumerator) /
      NodeopGasEstimateBufferDenominator
    expect(bufferedGasLimit).toBe(16_200_000n)
    expect(
      BigInt(AnvilEthereumTransactionPolicyConfig.MaximumGasLimit)
    ).toBeGreaterThanOrEqual(bufferedGasLimit)
  })
})
