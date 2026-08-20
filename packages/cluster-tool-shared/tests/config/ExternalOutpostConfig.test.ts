import {
  ExternalOutpostConfigSchema,
  ExternalOutpostConfigSchemaCodec,
  type ExternalOutpostConfig
} from "@wireio/cluster-tool-shared"

/** An authoritative ETH outpost endpoint no local binding could describe. */
const EthereumRpcUrl = "https://ethereum-rpc.external.example/"
/** An authoritative SOL outpost endpoint no local binding could describe. */
const SolanaRpcUrl = "https://solana-rpc.external.example/"

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

  it("round-trips an authoritative per-chain rpcUrl on BOTH outposts", () => {
    // D6: a mainnet / integrated-testnet outpost's endpoint cannot be described
    // by any local binding, so it travels on the outpost config itself.
    const remote: ExternalOutpostConfig = {
      ethereum: {
        addressFile: "outpost-addrs.json",
        abiFiles: ["eth-abis/OPP.json"],
        chainId: 1,
        rpcUrl: EthereumRpcUrl
      },
      solana: { idlFile: "idl.json", rpcUrl: SolanaRpcUrl }
    }
    const decoded = ExternalOutpostConfigSchemaCodec.deserialize(
      ExternalOutpostConfigSchemaCodec.serialize(remote)
    )
    expect(decoded).toEqual(remote)
    expect(decoded.ethereum.rpcUrl).toBe(EthereumRpcUrl)
    expect(decoded.solana.rpcUrl).toBe(SolanaRpcUrl)
  })

  it("leaves rpcUrl genuinely OPTIONAL on both chains (bind-governed dev externals)", () => {
    // The field must never become required or defaulted: every hand-built
    // config literal in the tree omits it and must keep parsing unchanged.
    expect(ExternalOutpostConfigSchema.safeParse(config).success).toBe(true)
    const decoded = ExternalOutpostConfigSchemaCodec.deserialize(
      ExternalOutpostConfigSchemaCodec.serialize(config)
    )
    expect(decoded.ethereum.rpcUrl).toBeUndefined()
    expect(decoded.solana.rpcUrl).toBeUndefined()
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
