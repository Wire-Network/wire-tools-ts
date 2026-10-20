import {
  ExternalOutpostConfig,
  ExternalOutpostConfigSchema,
  ExternalOutpostConfigSchemaCodec
} from "@wireio/cluster-tool-shared"

/** An authoritative ETH outpost endpoint no local binding could describe. */
const EthereumRpcUrl = "https://ethereum-rpc.external.example/"
/** An authoritative SOL outpost endpoint no local binding could describe. */
const SolanaRpcUrl = "https://solana-rpc.external.example/"
/** The Ethereum outpost's chain id (Hoodi). */
const ChainId = 560_048
/** A deployed `liqsol_core` program id. */
const ProgramId = "5nBtmutQLrRKBUxNfHJPDjiW5u8id6QM9Hhjg1D1g1XH"
/** The outpost contract addresses every config must carry. */
const OutpostAddresses = {
  OPP: "0x87CE3Fe2CDca39C04aa2c14bbF1E1d9DB6358C4A",
  OPPInbound: "0x0B1f7FB1c7f01A9cf490a1387E1E100F2bEA6C6d",
  BAR: "0xbAFac13ffd3Aa9aEabaaeb6e4C2cF3dFf3479DC0"
}

/** The minimal valid config: chain id, the required addresses, the program id. */
function minimalConfig(): ExternalOutpostConfig {
  return {
    ethereum: { chainId: ChainId, outpostAddresses: { ...OutpostAddresses } },
    solana: { programId: ProgramId }
  }
}

describe("ExternalOutpostConfig", () => {
  it("round-trips the minimal value-only config through the codec", () => {
    const config = minimalConfig()
    expect(
      ExternalOutpostConfigSchemaCodec.deserialize(
        ExternalOutpostConfigSchemaCodec.serialize(config)
      )
    ).toEqual(config)
  })

  it("round-trips every optional value: rpcUrl, liqEth addresses and SPL mints", () => {
    const full: ExternalOutpostConfig = {
      ethereum: {
        chainId: ChainId,
        rpcUrl: EthereumRpcUrl,
        outpostAddresses: { ...OutpostAddresses, Pool: OutpostAddresses.OPP },
        liqEthAddresses: {
          LiqEthToken: "0x8C974517D038e2e3b8a1da7b1A026bC8132A4b2e"
        }
      },
      solana: {
        rpcUrl: SolanaRpcUrl,
        programId: ProgramId,
        mints: [{ code: 1_234, mint: ProgramId, decimals: 9 }]
      }
    }
    const decoded = ExternalOutpostConfigSchemaCodec.deserialize(
      ExternalOutpostConfigSchemaCodec.serialize(full)
    )
    expect(decoded).toEqual(full)
    expect(decoded.ethereum.rpcUrl).toBe(EthereumRpcUrl)
    expect(decoded.solana.rpcUrl).toBe(SolanaRpcUrl)
  })

  it("leaves rpcUrl, liqEthAddresses and mints optional", () => {
    const decoded = ExternalOutpostConfigSchemaCodec.deserialize(
      ExternalOutpostConfigSchemaCodec.serialize(minimalConfig())
    )
    expect(decoded.ethereum.rpcUrl).toBeUndefined()
    expect(decoded.ethereum.liqEthAddresses).toBeUndefined()
    expect(decoded.solana.rpcUrl).toBeUndefined()
    expect(decoded.solana.mints).toBeUndefined()
  })

  it("requires the addresses of OPP, OPPInbound and BAR", () => {
    expect(ExternalOutpostConfig.RequiredOutpostContractNames).toEqual([
      "OPP",
      "OPPInbound",
      "BAR"
    ])
  })

  it.each(ExternalOutpostConfig.RequiredOutpostContractNames)(
    "rejects outpostAddresses without %s, naming it",
    name => {
      const config = minimalConfig()
      delete config.ethereum.outpostAddresses[name]
      const result = ExternalOutpostConfigSchema.safeParse(config)
      expect(result.success).toBe(false)
      expect(result.error.issues.map(issue => issue.message)).toContain(
        `outpostAddresses is missing the ${name} address`
      )
    }
  )

  it("rejects an address that is not an EVM address", () => {
    const config = minimalConfig()
    config.ethereum.outpostAddresses.OPP = "0x1234"
    expect(ExternalOutpostConfigSchema.safeParse(config).success).toBe(false)
  })

  it("rejects a program id that is not a base58 public key", () => {
    const config = minimalConfig()
    config.solana.programId = "0OIl-not-base58"
    expect(ExternalOutpostConfigSchema.safeParse(config).success).toBe(false)
  })

  it("rejects a non-positive chainId", () => {
    const config = minimalConfig()
    config.ethereum.chainId = 0
    expect(ExternalOutpostConfigSchema.safeParse(config).success).toBe(false)
  })

  it("rejects keys it does not declare — the config carries values, never file references", () => {
    expect(
      ExternalOutpostConfigSchema.safeParse({
        ...minimalConfig(),
        solana: { programId: ProgramId, idlFile: "liqsol_core.json" }
      }).success
    ).toBe(false)
  })
})
