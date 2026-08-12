import { AnvilEthereumTransactionPolicy } from "@wireio/cluster-tool/tools/ethereum"

describe("AnvilEthereumTransactionPolicy", () => {
  it("defines the finite local SEC-131 limits in canonical decimal form", () => {
    expect(AnvilEthereumTransactionPolicy.create()).toEqual({
      max_priority_fee_per_gas_wei: "2000000000",
      max_fee_per_gas_wei: "100000000000",
      max_gas_limit: "2000000",
      max_total_native_cost_wei: "250000000000000000"
    })
  })

  it("keeps the full fee, gas, and total-cost cap relationship valid", () => {
    const policy = AnvilEthereumTransactionPolicy.create()
    expect(BigInt(policy.max_priority_fee_per_gas_wei)).toBeLessThanOrEqual(
      BigInt(policy.max_fee_per_gas_wei)
    )
    expect(BigInt(policy.max_total_native_cost_wei)).toBeGreaterThanOrEqual(
      BigInt(policy.max_gas_limit) * BigInt(policy.max_fee_per_gas_wei)
    )
  })
})
