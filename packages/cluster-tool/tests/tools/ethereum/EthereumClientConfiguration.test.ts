import {
  EthereumClientConfiguration,
  type EthereumClientConfigurationFile,
  type EthereumTransactionPolicy
} from "@wireio/cluster-tool/tools/ethereum"

const BaseOptions: EthereumClientConfiguration.CreateOptions = {
  clientId: "eth-default",
  signatureProviderId: "eth-batchopaaaa",
  rpcUrl: "http://127.0.0.1:8545",
  chainId: 31_337
}

const FinitePolicy: EthereumTransactionPolicy = {
  max_priority_fee_per_gas_wei: "2000000000",
  max_fee_per_gas_wei: "100000000000",
  max_gas_limit: "2000000",
  max_total_native_cost_wei: "250000000000000000"
}

function fileWith(
  changes: Partial<EthereumClientConfigurationFile["clients"][number]>
): EthereumClientConfigurationFile {
  const file = EthereumClientConfiguration.create(BaseOptions)
  return { ...file, clients: [{ ...file.clients[0], ...changes }] }
}

describe("EthereumClientConfiguration", () => {
  it("creates the unified schema without a policy so nodeop applies permissive defaults", () => {
    expect(EthereumClientConfiguration.create(BaseOptions)).toEqual({
      version: 1,
      clients: [
        {
          client_id: "eth-default",
          signature_provider_id: "eth-batchopaaaa",
          rpc_url: "http://127.0.0.1:8545",
          chain_id: "31337"
        }
      ]
    })
  })

  it("includes and validates an explicitly requested finite policy", () => {
    expect(
      EthereumClientConfiguration.create({
        ...BaseOptions,
        transactionPolicy: FinitePolicy
      }).clients[0].transaction_policy
    ).toEqual(FinitePolicy)
  })

  it("accepts identifier boundaries and rejects unsafe client ids", () => {
    expect(
      EthereumClientConfiguration.create({
        ...BaseOptions,
        clientId: "a".repeat(64)
      }).clients[0].client_id
    ).toHaveLength(64)
    expect(() =>
      EthereumClientConfiguration.create({ ...BaseOptions, clientId: "" })
    ).toThrow(/client_id must be 1-64 ASCII/)
    expect(() =>
      EthereumClientConfiguration.create({ ...BaseOptions, clientId: "bad,id" })
    ).toThrow(/client_id must be 1-64 ASCII/)
  })

  it("rejects missing providers, unsupported URLs, and non-uint32 chain ids", () => {
    expect(() =>
      EthereumClientConfiguration.create({
        ...BaseOptions,
        signatureProviderId: ""
      })
    ).toThrow(/signature_provider_id must not be empty/)
    expect(() =>
      EthereumClientConfiguration.create({
        ...BaseOptions,
        rpcUrl: "ws://127.0.0.1:8545"
      })
    ).toThrow(/rpc_url must use http or https/)
    expect(() =>
      EthereumClientConfiguration.create({ ...BaseOptions, chainId: 2 ** 32 })
    ).toThrow(/chain_id exceeds its supported domain/)
  })

  it("rejects non-canonical, overflowing, and inconsistent finite policies", () => {
    expect(() =>
      EthereumClientConfiguration.assertValid(
        fileWith({
          transaction_policy: { ...FinitePolicy, max_gas_limit: "02000000" }
        })
      )
    ).toThrow(/max_gas_limit must be a canonical positive decimal string/)
    expect(() =>
      EthereumClientConfiguration.assertValid(
        fileWith({
          transaction_policy: {
            ...FinitePolicy,
            max_gas_limit: (1n << 256n).toString()
          }
        })
      )
    ).toThrow(/max_gas_limit exceeds its supported domain/)
    expect(() =>
      EthereumClientConfiguration.assertValid(
        fileWith({
          transaction_policy: {
            ...FinitePolicy,
            max_priority_fee_per_gas_wei: "100000000001"
          }
        })
      )
    ).toThrow(/priority-fee cap must not exceed maximum-fee cap/)
  })

  it("accepts an independent total-cost cap below the gas and fee caps' product", () => {
    expect(() =>
      EthereumClientConfiguration.assertValid(
        fileWith({
          transaction_policy: {
            ...FinitePolicy,
            max_total_native_cost_wei: "1"
          }
        })
      )
    ).not.toThrow()
  })

  it("rejects a wrong schema version or client count", () => {
    const file = EthereumClientConfiguration.create(BaseOptions)
    expect(() =>
      EthereumClientConfiguration.assertValid({ ...file, version: 2 })
    ).toThrow(/version must be 1/)
    expect(() =>
      EthereumClientConfiguration.assertValid({ ...file, clients: [] })
    ).toThrow(/must contain exactly one client/)
  })
})
