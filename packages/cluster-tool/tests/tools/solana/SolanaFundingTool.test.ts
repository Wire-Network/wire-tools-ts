import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { SolanaFundingTool } from "@wireio/cluster-tool/tools/solana"
import { Connection, Keypair } from "@solana/web3.js"
import { BindConfig } from "@wireio/cluster-tool/config"
import { Report } from "@wireio/cluster-tool/report"
import { toURL } from "@wireio/cluster-tool/utils"

describe("SolanaFundingTool input validation", () => {
  // The Assert guards fire before any RPC, so this connection is never dialed —
  // but the URL still resolves via BindConfig.findAvailable (no fixed port).
  const funder = Keypair.generate()
  let connection: Connection
  beforeAll(async () => {
    connection = new Connection(toURL(await BindConfig.findAvailable(BindConfig.DefaultSolanaRpc)))
  })

  it("createMockSplMint rejects out-of-range decimals", async () => {
    await expect(
      SolanaFundingTool.createMockSplMint(connection, funder, SolanaFundingTool.MaxDecimals + 1)
    ).rejects.toThrow(/decimals must be in/)
  })

  it("mintMockSplToUser rejects a non-positive amount", async () => {
    const mint = Keypair.generate().publicKey
    const recipient = Keypair.generate().publicKey
    await expect(
      SolanaFundingTool.mintMockSplToUser(connection, funder, mint, recipient, 0n)
    ).rejects.toThrow(/amount must be > 0/)
  })

  it("exposes the decimal bounds", () => {
    expect(SolanaFundingTool.MinDecimals).toBe(0)
    expect(SolanaFundingTool.MaxDecimals).toBe(18)
  })
})

describe("SolanaFundingTool step factories", () => {
  it("airdrop builds a Step carrying the operator + floor input", () => {
    const step = SolanaFundingTool.planAirdrop(
      Report.Actor.Underwriter,
      "uwa-airdrop",
      "fund uwa",
      {},
      "uwa",
      7n
    )
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.name).toBe("uwa-airdrop")
    expect(step.input.kind).toBe("SolanaFundingTool.AirdropInput")
    expect(step.input.operatorAccount).toBe("uwa")
    expect(step.input.floorLamports).toBe(7n)
  })

  it("mintSpl builds a Step carrying the operator + tokenCode + amount input", () => {
    const step = SolanaFundingTool.planSplMint(
      Report.Actor.Underwriter,
      "uwa-usdcsol-mint",
      "mint usdcsol",
      {},
      "uwa",
      123n,
      9n
    )
    expect(step.input.kind).toBe("SolanaFundingTool.MintSplInput")
    expect(step.input.tokenCode).toBe(123n)
    expect(step.input.amount).toBe(9n)
  })

  it("loadDeployerKeypair throws when the persisted keypair is absent", () => {
    expect(() => SolanaFundingTool.loadDeployerKeypair("/no/such/data/dir")).toThrow(
      /deployer keypair not found/
    )
  })
})

describe("SolanaFundingTool.solMintAddress", () => {
  let dataPath: string
  beforeAll(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "sol-mints-"))
    Fs.writeFileSync(
      Path.join(dataPath, SolanaFundingTool.SolMockMintsFilename),
      JSON.stringify([{ code: 123, mint: "MintPubkeyBase58", decimals: 6 }])
    )
  })
  afterAll(() => {
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  it("resolves a persisted mock mint by token code", () => {
    expect(SolanaFundingTool.solMintAddress(dataPath, 123n)).toBe("MintPubkeyBase58")
  })

  it("throws LOUDLY for a token code with no persisted mint (never a silent skip)", () => {
    expect(() => SolanaFundingTool.solMintAddress(dataPath, 999n)).toThrow(
      /no mock SPL mint persisted for token code 999/
    )
  })

  it("throws when the mint manifest is absent entirely", () => {
    expect(() => SolanaFundingTool.solMintAddress("/no/such/data", 123n)).toThrow(
      /mock SPL mints not found/
    )
  })
})
