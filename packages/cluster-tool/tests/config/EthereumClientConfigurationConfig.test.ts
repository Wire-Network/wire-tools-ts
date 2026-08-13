import {
  AnvilEthereumTransactionPolicyConfig,
  EthereumClientConfigurationConfig,
  type EthereumClientConfigurationFile,
  type EthereumTransactionPolicy
} from "@wireio/cluster-tool/config"

const FinitePolicy: EthereumTransactionPolicy =
  AnvilEthereumTransactionPolicyConfig.create()

function fileWith(
  changes: Partial<EthereumClientConfigurationFile["clients"][number]>
): EthereumClientConfigurationFile {
  const file = EthereumClientConfigurationConfig.create(
    "eth-default",
    "eth-batchopaaaa",
    "http://anvil.test",
    31_337
  )
  return { ...file, clients: [{ ...file.clients[0], ...changes }] }
}

describe("EthereumClientConfigurationConfig", () => {
  it("emits the final SEC-131 host-only ProtoJSON shape", () => {
    expect(
      EthereumClientConfigurationConfig.toJson(
        EthereumClientConfigurationConfig.create(
          "eth-default",
          "eth-batchopaaaa",
          "http://anvil.test",
          31_337,
          FinitePolicy
        )
      )
    ).toEqual({
      schema_version: 1,
      clients: [
        {
          connection: {
            client_id: "eth-default",
            signature_provider_id: "eth-batchopaaaa",
            rpc_url: "http://anvil.test"
          },
          chain_id: 31_337,
          transaction_policy: FinitePolicy
        }
      ]
    })
  })

  it("keeps external clients policy-free for operator-selected production limits", () => {
    expect(
      EthereumClientConfigurationConfig.create(
        "eth-default",
        "eth-default",
        "https://ethereum.example",
        11_155_111
      )
    ).toEqual({
      schema_version: 1,
      clients: [
        {
          connection: {
            client_id: "eth-default",
            signature_provider_id: "eth-default",
            rpc_url: "https://ethereum.example"
          },
          chain_id: 11_155_111
        }
      ]
    })
  })

  it("rejects invalid host configuration and policy values", () => {
    expect(() =>
      EthereumClientConfigurationConfig.create(
        "bad,id",
        "eth-default",
        "http://anvil.test",
        31_337
      )
    ).toThrow(/client_id must be 1-64 ASCII/)
    expect(() =>
      EthereumClientConfigurationConfig.create(
        "eth-default",
        "eth-default",
        "ws://anvil.test",
        31_337
      )
    ).toThrow(/rpc_url must use http or https/)
    expect(() =>
      EthereumClientConfigurationConfig.assertValid(
        fileWith({
          transaction_policy: {
            ...FinitePolicy,
            max_gas_limit: "06000000"
          }
        })
      )
    ).toThrow(/max_gas_limit must be a canonical positive decimal string/)
  })
})
