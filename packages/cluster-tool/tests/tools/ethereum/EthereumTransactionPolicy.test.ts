import {
  AnvilEthereumTransactionPolicy,
  type EthereumTransactionPolicy,
  type EthereumTransactionPolicyFile
} from "@wireio/cluster-tool/tools/ethereum"

const ClientId = "eth-default",
  ChainId = 31_337

/** A valid generated file with one policy field replaced for rejection tests. */
function policyFileWith(
  changes: Partial<EthereumTransactionPolicy>
): EthereumTransactionPolicyFile {
  const file = AnvilEthereumTransactionPolicy.create(ClientId, ChainId)
  return {
    ...file,
    policies: [{ ...file.policies[0], ...changes }]
  }
}

describe("AnvilEthereumTransactionPolicy", () => {
  it("defines every finite Anvil limit exactly in canonical decimal form", () => {
    expect(AnvilEthereumTransactionPolicy.SchemaVersion).toBe(1)
    expect(
      AnvilEthereumTransactionPolicy.MaximumPriorityFeePerGasWei.toString()
    ).toBe("2000000000")
    expect(AnvilEthereumTransactionPolicy.MaximumFeePerGasWei.toString()).toBe(
      "100000000000"
    )
    expect(AnvilEthereumTransactionPolicy.MaximumGasLimit.toString()).toBe(
      "2000000"
    )
    expect(
      AnvilEthereumTransactionPolicy.MaximumTotalNativeCostWei.toString()
    ).toBe("250000000000000000")
  })

  it("creates the exact SEC-131 single-client JSON schema", () => {
    expect(AnvilEthereumTransactionPolicy.create(ClientId, ChainId)).toEqual({
      version: 1,
      policies: [
        {
          client_id: "eth-default",
          chain_id: "31337",
          max_priority_fee_per_gas_wei: "2000000000",
          max_fee_per_gas_wei: "100000000000",
          max_gas_limit: "2000000",
          max_total_native_cost_wei: "250000000000000000"
        }
      ]
    })
  })

  it("keeps fee and full maximum-cost relationships valid", () => {
    expect(
      AnvilEthereumTransactionPolicy.MaximumPriorityFeePerGasWei
    ).toBeLessThanOrEqual(AnvilEthereumTransactionPolicy.MaximumFeePerGasWei)
    expect(
      AnvilEthereumTransactionPolicy.MaximumTotalNativeCostWei
    ).toBeGreaterThanOrEqual(
      AnvilEthereumTransactionPolicy.MaximumGasLimit *
        AnvilEthereumTransactionPolicy.MaximumFeePerGasWei
    )
  })

  it("accepts the SEC-131 client-id boundary and rejects unsafe identifiers", () => {
    expect(
      AnvilEthereumTransactionPolicy.create("a".repeat(64), ChainId).policies[0]
        .client_id
    ).toHaveLength(64)
    expect(() => AnvilEthereumTransactionPolicy.create("", ChainId)).toThrow(
      /client_id must be 1-64 ASCII/
    )
    expect(() =>
      AnvilEthereumTransactionPolicy.create("bad,id", ChainId)
    ).toThrow(/client_id must be 1-64 ASCII/)
    expect(() =>
      AnvilEthereumTransactionPolicy.create("a".repeat(65), ChainId)
    ).toThrow(/client_id must be 1-64 ASCII/)
  })

  it("rejects a non-uint32 chain id", () => {
    expect(() =>
      AnvilEthereumTransactionPolicy.create(ClientId, 2 ** 32)
    ).toThrow(/chain_id must fit uint32/)
  })

  it("rejects non-canonical, zero, and uint256-overflowing fields", () => {
    expect(() =>
      AnvilEthereumTransactionPolicy.assertValid(
        policyFileWith({ max_gas_limit: "02000000" })
      )
    ).toThrow(/max_gas_limit must be a canonical positive decimal string/)
    expect(() =>
      AnvilEthereumTransactionPolicy.assertValid(
        policyFileWith({ max_gas_limit: "0" })
      )
    ).toThrow(/max_gas_limit must be a canonical positive decimal string/)
    expect(() =>
      AnvilEthereumTransactionPolicy.assertValid(
        policyFileWith({ max_gas_limit: (1n << 256n).toString() })
      )
    ).toThrow(/max_gas_limit must fit uint256/)
  })

  it("rejects inconsistent fee and total-cost relationships", () => {
    expect(() =>
      AnvilEthereumTransactionPolicy.assertValid(
        policyFileWith({
          max_priority_fee_per_gas_wei: "100000000001"
        })
      )
    ).toThrow(/priority-fee cap must not exceed maximum-fee cap/)
    expect(() =>
      AnvilEthereumTransactionPolicy.assertValid(
        policyFileWith({ max_total_native_cost_wei: "199999999999999999" })
      )
    ).toThrow(/total-cost cap must cover gas-limit × maximum-fee caps/)
  })

  it("rejects a wrong schema version or policy count", () => {
    const file = AnvilEthereumTransactionPolicy.create(ClientId, ChainId)
    expect(() =>
      AnvilEthereumTransactionPolicy.assertValid({ ...file, version: 2 })
    ).toThrow(/version must be 1/)
    expect(() =>
      AnvilEthereumTransactionPolicy.assertValid({ ...file, policies: [] })
    ).toThrow(/must contain exactly one client policy/)
  })
})
