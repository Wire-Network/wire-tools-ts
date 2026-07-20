import {
  ExternalOutpostConfigSchema,
  ExternalOutpostConfigSchemaCodec,
  type ExternalOutpostConfig
} from "@wireio/cluster-tool-shared"

describe("ExternalOutpostConfig", () => {
  const config: ExternalOutpostConfig = {
    ethereum: {
      addressFile: "outpost-addrs.json",
      abiFiles: ["eth-abis/OPP.json", "eth-abis/OperatorRegistry.json"],
      chainId: 1
    },
    solana: { idlFile: "solana-idls/opp_outpost.json" }
  }

  it("round-trips through the codec", () => {
    expect(
      ExternalOutpostConfigSchemaCodec.deserialize(
        ExternalOutpostConfigSchemaCodec.serialize(config)
      )
    ).toEqual(config)
  })

  it("round-trips the optional liqEth + SPL-mints FILE references", () => {
    const full: ExternalOutpostConfig = {
      ethereum: {
        addressFile: "outpost-addrs.json",
        abiFiles: ["eth-abis/OPP.json"],
        chainId: 1,
        liqEthAddressFile: "liqeth-addrs.json"
      },
      solana: { idlFile: "idl.json", mintsFile: "sol-mock-mints.json" }
    }
    expect(
      ExternalOutpostConfigSchemaCodec.deserialize(
        ExternalOutpostConfigSchemaCodec.serialize(full)
      )
    ).toEqual(full)
  })

  it("requires ethereum.addressFile", () => {
    expect(
      ExternalOutpostConfigSchema.safeParse({
        ethereum: { abiFiles: [], chainId: 1 },
        solana: { idlFile: "x" }
      }).success
    ).toBe(false)
  })

  it("rejects a non-positive chainId", () => {
    expect(
      ExternalOutpostConfigSchema.safeParse({
        ethereum: { addressFile: "a", abiFiles: [], chainId: 0 },
        solana: { idlFile: "x" }
      }).success
    ).toBe(false)
  })

  it("requires the solana idlFile", () => {
    expect(
      ExternalOutpostConfigSchema.safeParse({
        ethereum: { addressFile: "a", abiFiles: [], chainId: 1 },
        solana: {}
      }).success
    ).toBe(false)
  })
})
