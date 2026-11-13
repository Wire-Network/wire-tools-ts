import {
  AnvilEthereumTransactionPolicyConfig,
  EthereumClientConfigurationConfig,
  type EthereumClientConfigurationFile,
  type EthereumTransactionPolicy
} from "@wireio/cluster-tool/config"
import {
  EthereumReadBlockTag,
  createUnsetEthereumReadConfirmationConfig
} from "@wireio/cluster-tool-shared"

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
    ).toThrow(/rpc_url/)
    expect(() =>
      EthereumClientConfigurationConfig.assertValid(
        fileWith({
          transaction_policy: {
            ...FinitePolicy,
            max_gas_limit: "06000000"
          }
        })
      )
    ).toThrow(/max_gas_limit.*must be a canonical positive decimal string/)
  })

  it.each([
    [EthereumReadBlockTag.safe, "EVM_READ_BLOCK_TAG_SAFE"],
    [EthereumReadBlockTag.finalized, "EVM_READ_BLOCK_TAG_FINALIZED"],
    [EthereumReadBlockTag.latest, "EVM_READ_BLOCK_TAG_LATEST"]
  ])(
    "preserves the %s read tag in the per-client JSON",
    (blockTag, expected) => {
      const file = EthereumClientConfigurationConfig.create(
        "ETHEREUM",
        "eth-default",
        "https://ethereum.example",
        1,
        undefined,
        {
          ...createUnsetEthereumReadConfirmationConfig(),
          blockTag: blockTag as EthereumReadBlockTag
        }
      )
      expect(file.clients[0].read_confirmation).toEqual({ block_tag: expected })
      expect(
        JSON.parse(EthereumClientConfigurationConfig.serialize(file))
      ).toEqual(file)
    }
  )

  it("carries explicit read depth and lag while leaving an unset tag to nodeop", () => {
    const file = EthereumClientConfigurationConfig.create(
      "ETHEREUM",
      "eth-default",
      "https://ethereum.example",
      1,
      undefined,
      { blockTag: null, confirmations: 20, maxFinalityLagSec: 600 }
    )
    expect(file.clients[0].read_confirmation).toEqual({
      confirmations: 20,
      max_finality_lag_sec: 600
    })
  })

  it("rejects read settings nodeop cannot apply", () => {
    expect(() =>
      EthereumClientConfigurationConfig.create(
        "ETHEREUM",
        "eth-default",
        "https://ethereum.example",
        1,
        undefined,
        {
          blockTag: EthereumReadBlockTag.safe,
          confirmations: 12,
          maxFinalityLagSec: null
        }
      )
    ).toThrow(/confirmations applies only/)
    expect(() =>
      EthereumClientConfigurationConfig.create(
        "ETHEREUM",
        "eth-default",
        "https://ethereum.example",
        1,
        undefined,
        { blockTag: null, confirmations: 0, maxFinalityLagSec: null }
      )
    ).toThrow()
  })

  it.each(["0", "-1", "+1", "1.5", "abc", (1n << 256n).toString()])(
    "rejects the invalid policy integer %s before writing an artifact",
    value => {
      const file = fileWith({
        transaction_policy: { ...FinitePolicy, max_gas_limit: value }
      })
      expect(() =>
        EthereumClientConfigurationConfig.assertValid(file)
      ).toThrow()
      expect(() => EthereumClientConfigurationConfig.serialize(file)).toThrow()
    }
  )

  it("rejects invalid client cardinality, chain ids, and fee ordering", () => {
    const file = fileWith({})
    expect(() =>
      EthereumClientConfigurationConfig.assertValid({ ...file, clients: [] })
    ).toThrow()
    expect(() =>
      EthereumClientConfigurationConfig.assertValid({
        ...file,
        clients: [...file.clients, ...file.clients]
      })
    ).toThrow()
    ;[0, 2 ** 32, 1.5].forEach(chain_id => {
      expect(() =>
        EthereumClientConfigurationConfig.assertValid(fileWith({ chain_id }))
      ).toThrow()
    })
    expect(() =>
      EthereumClientConfigurationConfig.assertTransactionPolicy({
        ...FinitePolicy,
        max_priority_fee_per_gas_wei: (
          BigInt(FinitePolicy.max_fee_per_gas_wei) + 1n
        ).toString()
      })
    ).toThrow(/priority-fee cap/)
  })
})
