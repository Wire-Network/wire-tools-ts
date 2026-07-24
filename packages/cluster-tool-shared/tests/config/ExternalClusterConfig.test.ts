import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import {
  ExternalClusterConfigSchema,
  ExternalClusterConfigSchemaCodec,
  SignatureProviderType,
  type ExternalClusterConfig
} from "@wireio/cluster-tool-shared"

describe("ExternalClusterConfig", () => {
  const config: ExternalClusterConfig = {
    bindings: {
      kiod: { address: "127.0.0.1", port: 8900 },
      nodeop: {
        address: "127.0.0.1",
        ports: {
          bios: { http: 8888, p2p: 9876 },
          producers: [{ http: 8988, p2p: 9976 }],
          batch: [],
          underwriters: []
        }
      },
      anvil: { address: "10.0.0.1", port: 8545 },
      solana: {
        address: "10.0.0.2",
        ports: {
          http: 8899,
          faucet: 9900,
          gossip: 8001,
          dynamicRange: { first: 8100, last: 8200 }
        }
      },
      debuggingServer: { address: "127.0.0.1", port: 9901 }
    },
    accounts: {
      operators: [
        {
          accountName: "batchop1",
          type: OperatorType.BATCH,
          keyProviders: [
            {
              providerType: SignatureProviderType.KEY,
              type: KeyType.K1,
              publicKey: "PUB_K1_x",
              privateKey: "PVT_K1_y"
            }
          ]
        }
      ]
    },
    wire: { epochDurationSec: 60 },
    ethereum: {
      addressFile: "outpost-addrs.json",
      abiFiles: ["eth-abis/OPP.json"],
      chainId: 1
    }
  }

  it("carries the operator type as its NAME in JSON but the numeric enum in memory", () => {
    const parsed = JSON.parse(ExternalClusterConfigSchemaCodec.serialize(config))
    expect(parsed.accounts.operators[0].type).toBe("BATCH")

    const rehydrated = ExternalClusterConfigSchemaCodec.deserialize(
      ExternalClusterConfigSchemaCodec.serialize(config)
    )
    expect(rehydrated.accounts.operators[0].type).toBe(OperatorType.BATCH)
    expect(rehydrated).toEqual(config)
  })

  it("requires at least one keyProvider per account", () => {
    const parsed = JSON.parse(ExternalClusterConfigSchemaCodec.serialize(config))
    parsed.accounts.operators[0].keyProviders = []
    expect(ExternalClusterConfigSchema.safeParse(parsed).success).toBe(false)
  })

  it("rejects an unknown operator type name", () => {
    const parsed = JSON.parse(ExternalClusterConfigSchemaCodec.serialize(config))
    parsed.accounts.operators[0].type = "BOGUS"
    expect(ExternalClusterConfigSchema.safeParse(parsed).success).toBe(false)
  })

  it("allows an omitted solana section (ETH-only external cluster)", () => {
    const parsed = JSON.parse(ExternalClusterConfigSchemaCodec.serialize(config))
    delete parsed.solana
    expect(ExternalClusterConfigSchema.safeParse(parsed).success).toBe(true)
  })
})
