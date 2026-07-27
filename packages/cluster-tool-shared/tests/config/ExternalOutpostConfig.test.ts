import {
  ExternalOutpostConfigSchema,
  ExternalOutpostConfigSchemaCodec,
  type ExternalOutpostConfig
} from "@wireio/cluster-tool-shared"

describe("ExternalOutpostConfig", () => {
  const GenesisHash = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"
  const config: ExternalOutpostConfig = {
    ethereum: {
      addressFile: "outpost-addrs.json",
      abiFiles: ["eth-abis/OPP.json", "eth-abis/OperatorRegistry.json"],
      chainId: 1
    },
    solana: {
      idlFile: "solana-idls/opp_outpost.json",
      genesisHash: GenesisHash
    }
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
      solana: {
        idlFile: "idl.json",
        genesisHash: GenesisHash,
        mintsFile: "sol-mock-mints.json"
      }
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
        solana: { idlFile: "x", genesisHash: GenesisHash }
      }).success
    ).toBe(false)
  })

  it("rejects a non-positive chainId", () => {
    expect(
      ExternalOutpostConfigSchema.safeParse({
        ethereum: { addressFile: "a", abiFiles: [], chainId: 0 },
        solana: { idlFile: "x", genesisHash: GenesisHash }
      }).success
    ).toBe(false)
  })

  it("requires the solana idlFile", () => {
    expect(
      ExternalOutpostConfigSchema.safeParse({
        ethereum: { addressFile: "a", abiFiles: [], chainId: 1 },
        solana: { genesisHash: GenesisHash }
      }).success
    ).toBe(false)
  })

  it("requires a canonical solana genesisHash", () => {
    expect(
      ExternalOutpostConfigSchema.safeParse({
        ethereum: { addressFile: "a", abiFiles: [], chainId: 1 },
        solana: { idlFile: "x" }
      }).success
    ).toBe(false)
    expect(
      ExternalOutpostConfigSchema.safeParse({
        ethereum: { addressFile: "a", abiFiles: [], chainId: 1 },
        solana: { idlFile: "x", genesisHash: "not-a-hash" }
      }).success
    ).toBe(false)
  })
})
