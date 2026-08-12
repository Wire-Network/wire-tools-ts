import {
  AnvilEthereumTransactionPolicy,
  EthereumClientConfiguration,
  type EthereumClientConfigurationFile,
  type EthereumTransactionPolicy
} from "@wireio/cluster-tool/tools/ethereum"

const BaseOptions: EthereumClientConfiguration.CreateOptions = {
  clientId: "eth-default",
  signatureProviderId: "eth-batchopaaaa",
  // This configuration-only test never dials the endpoint, so keep the URL
  // host-only rather than hard-coding an Anvil port outside BindConfigProvider.
  rpcUrl: "http://anvil.test",
  chainId: 31_337
}

const FinitePolicy: EthereumTransactionPolicy = AnvilEthereumTransactionPolicy.create()

function fileWith(
  changes: Partial<EthereumClientConfigurationFile["clients"][number]>
): EthereumClientConfigurationFile {
  const file = EthereumClientConfiguration.create(BaseOptions)
  return { ...file, clients: [{ ...file.clients[0], ...changes }] }
}

describe("EthereumClientConfiguration", () => {
  it("allows external configuration to omit a policy for operator-selected production limits", () => {
    expect(EthereumClientConfiguration.create(BaseOptions)).toEqual({
      schema_version: 1,
      clients: [
        {
          connection: {
            client_id: "eth-default",
            signature_provider_id: "eth-batchopaaaa",
            rpc_url: "http://anvil.test"
          },
          chain_id: 31_337
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
      }).clients[0].connection.client_id
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
        rpcUrl: "ws://anvil.test"
      })
    ).toThrow(/rpc_url must use http or https with a host and no fragment/)
    expect(() =>
      EthereumClientConfiguration.create({
        ...BaseOptions,
        rpcUrl: "http://anvil.test/#secret"
      })
    ).toThrow(/rpc_url must use http or https with a host and no fragment/)
    expect(() =>
      EthereumClientConfiguration.create({ ...BaseOptions, chainId: 0 })
    ).toThrow(/chain_id must be a positive uint32/)
    expect(() =>
      EthereumClientConfiguration.create({ ...BaseOptions, chainId: 2 ** 32 })
    ).toThrow(/chain_id must be a positive uint32/)
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
      EthereumClientConfiguration.assertValid({ ...file, schema_version: 2 })
    ).toThrow(/schema_version must be 1/)
    expect(() =>
      EthereumClientConfiguration.assertValid({ ...file, clients: [] })
    ).toThrow(/must contain exactly one client/)
  })
})
