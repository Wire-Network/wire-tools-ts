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
          underwriters: [],
          api: [],
          adHoc: []
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
      oppProtocol: { emit: [1], receive: [1, 2] },
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

  it("lists every OperatorType member name in the operator type's JSON Schema enum", () => {
    expect(ExternalClusterConfigSchemaCodec.toJSONSchema()).toMatchObject({
      properties: {
        accounts: {
          properties: {
            operators: {
              items: {
                properties: {
                  type: {
                    enum: ["UNKNOWN", "PRODUCER", "BATCH", "UNDERWRITER", "CHALLENGER"]
                  }
                }
              }
            }
          }
        }
      }
    })
  })

  it("allows an omitted solana section (ETH-only external cluster)", () => {
    const parsed = JSON.parse(ExternalClusterConfigSchemaCodec.serialize(config))
    delete parsed.solana
    expect(ExternalClusterConfigSchema.safeParse(parsed).success).toBe(true)
  })

  describe("outpost artifact sections", () => {
    it.each(["ethereum", "solana"] as const)(
      "requires the exported %s protocol declaration",
      chain => {
        const missing = JSON.parse(ExternalClusterConfigSchemaCodec.serialize({
          ...config,
          solana: { oppProtocol: { emit: [1], receive: [1, 2] }, idlFile: "solana-idls/liqsol_core.json" }
        }))
        delete missing[chain].oppProtocol
        expect(() => ExternalClusterConfigSchemaCodec.deserialize(JSON.stringify(missing))).toThrow(/oppProtocol/)
      }
    )

    it("round-trips every optional field: rpcUrls, liqEth record, SPL mints", () => {
      const full: ExternalClusterConfig = {
        ...config,
        ethereum: {
          ...config.ethereum,
          rpcUrl: "https://ethereum-rpc.external.example/",
          liqEthAddressFile: "liqeth-addrs.json"
        },
        solana: {
          oppProtocol: { emit: [1], receive: [1, 2] },
          idlFile: "solana-idls/liqsol_core.json",
          rpcUrl: "https://solana-rpc.external.example/",
          mintsFile: "sol-mock-mints.json"
        }
      }
      expect(
        ExternalClusterConfigSchemaCodec.deserialize(
          ExternalClusterConfigSchemaCodec.serialize(full)
        )
      ).toEqual(full)
    })

    it("requires the ethereum addressFile and the solana idlFile", () => {
      const withoutAddressFile = JSON.parse(
          ExternalClusterConfigSchemaCodec.serialize(config)
        ),
        withoutIdlFile = JSON.parse(
          ExternalClusterConfigSchemaCodec.serialize({
            ...config,
            solana: { oppProtocol: { emit: [1], receive: [1, 2] }, idlFile: "solana-idls/liqsol_core.json" }
          })
        )
      delete withoutAddressFile.ethereum.addressFile
      delete withoutIdlFile.solana.idlFile
      expect(
        ExternalClusterConfigSchema.safeParse(withoutAddressFile).success
      ).toBe(false)
      expect(ExternalClusterConfigSchema.safeParse(withoutIdlFile).success).toBe(
        false
      )
    })

    it("validates the chain id like the external-outpost config does", () => {
      const parsed = JSON.parse(ExternalClusterConfigSchemaCodec.serialize(config))
      parsed.ethereum.chainId = 0
      expect(ExternalClusterConfigSchema.safeParse(parsed).success).toBe(false)
    })
  })
})
