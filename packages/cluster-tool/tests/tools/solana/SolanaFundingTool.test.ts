import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { SolanaFundingTool } from "@wireio/cluster-tool/tools/solana"
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { SolanaClient } from "@wireio/cluster-tool/clients/solana"
import { Report } from "@wireio/cluster-tool/report"
import { toURL } from "@wireio/cluster-tool/utils"

describe("SolanaFundingTool input validation", () => {
  // The Assert guards fire before any RPC, so this connection is never dialed —
  // but the URL still resolves via BindConfigProvider.findAvailable (no fixed port).
  const funder = Keypair.generate()
  let connection: Connection
  beforeAll(async () => {
    connection = new Connection(toURL(await BindConfigProvider.findAvailable(BindConfigProvider.DefaultSolanaRpc)))
  })

  it("createMockSplMint rejects out-of-range decimals", async () => {
    await expect(
      SolanaFundingTool.createMockSplMint(connection, funder, SolanaFundingTool.MaxDecimals + 1)
    ).rejects.toThrow(/decimals must be in/)
  })

  it("mintMockSplToUser rejects a non-positive amount", async () => {
    const mint = Keypair.generate().publicKey
    const recipient = Keypair.generate().publicKey
    await expect(SolanaFundingTool.mintMockSplToUser(connection, funder, mint, recipient, 0n)).rejects.toThrow(
      /amount must be > 0/
    )
  })

  it("exposes the decimal bounds", () => {
    expect(SolanaFundingTool.MinDecimals).toBe(0)
    expect(SolanaFundingTool.MaxDecimals).toBe(18)
  })
})

/** A stub `Connection` plus a live count of raw transaction submissions. */
interface StubbedConnection {
  readonly connection: Connection
  readonly sent: () => number
}

describe("SolanaFundingTool.ensureAssociatedTokenAccount", () => {
  const funder = Keypair.generate()
  const mint = Keypair.generate().publicKey
  // An off-curve owner (a program PDA), exactly like reserve_aggregate.
  const [ownerPda] = PublicKey.findProgramAddressSync([Buffer.from("reserve_aggregate")], Keypair.generate().publicKey)

  /**
   * Stub the methods the SEND path actually uses. `sendAndPoll` signs against a
   * fetched blockhash and submits via `sendRawTransaction` (NOT
   * `sendTransaction`), then `confirmSignature` polls `getSignatureStatus` —
   * stubbing the wrong one makes the write-count assertion vacuous.
   *
   * @param accountInfo - What `getAccountInfo` reports for the ATA (`null` = absent).
   * @returns The stub connection plus a live counter of raw submissions.
   */
  function stubConnection(accountInfo: object | null): StubbedConnection {
    let sent = 0
    const connection = {
      getAccountInfo: async () => accountInfo,
      getLatestBlockhash: async () => ({
        blockhash: SystemProgram.programId.toBase58(),
        lastValidBlockHeight: 1
      }),
      sendRawTransaction: async () => {
        sent++
        return "signature"
      },
      getSignatureStatus: async () => ({
        value: { confirmationStatus: SolanaClient.ConfirmationStatus.confirmed }
      })
    } as unknown as Connection
    return { connection, sent: () => sent }
  }

  const existingAccount = {
    data: Buffer.alloc(0),
    executable: false,
    lamports: 1,
    owner: PublicKey.default,
    rentEpoch: 0
  }

  it("resolves the off-curve (owner, mint) ATA and skips the write when it already exists", async () => {
    const { connection, sent } = stubConnection(existingAccount)

    const ata = await SolanaFundingTool.ensureAssociatedTokenAccount(connection, funder, mint, ownerPda, true)
    expect(ata.equals(getAssociatedTokenAddressSync(mint, ownerPda, true))).toBe(true)
    expect(sent()).toBe(0)
  })

  // The branch SOL-380 depends on: a missing aggregate ATA must be CREATED, or
  // an SPL slash settles into a destination that does not exist and is dropped.
  it("creates the ATA when it is absent", async () => {
    const { connection, sent } = stubConnection(null)

    const ata = await SolanaFundingTool.ensureAssociatedTokenAccount(connection, funder, mint, ownerPda, true)
    expect(ata.equals(getAssociatedTokenAddressSync(mint, ownerPda, true))).toBe(true)
    expect(sent()).toBe(1)
  })

  it("derives an ON-curve wallet ATA when allowOwnerOffCurve is omitted", async () => {
    const wallet = Keypair.generate().publicKey,
      { connection } = stubConnection(existingAccount)

    expect(
      (await SolanaFundingTool.ensureAssociatedTokenAccount(connection, funder, mint, wallet)).equals(
        getAssociatedTokenAddressSync(mint, wallet)
      )
    ).toBe(true)
  })
})

describe("SolanaFundingTool step factories", () => {
  it("airdrop builds a Step carrying the operator + floor input", () => {
    const step = SolanaFundingTool.planAirdrop(Report.Actor.Underwriter, "uwa-airdrop", "fund uwa", {}, "uwa", 7n)
    expect(step.actor).toBe(Report.Actor.Underwriter)
    expect(step.name).toBe("uwa-airdrop")
    expect(step.input.kind).toBe("SolanaFundingTool.AirdropInput")
    expect(step.input.operatorLabel).toBe("uwa")
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
    expect(() => SolanaFundingTool.loadDeployerKeypair("/no/such/data/dir")).toThrow(/deployer keypair not found/)
  })
})

describe("SolanaFundingTool deployer keypair identity", () => {
  let dataPath: string
  beforeEach(() => {
    dataPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "sol-deployer-"))
  })
  afterEach(() => {
    Fs.rmSync(dataPath, { recursive: true, force: true })
  })

  it("deployerKeypairFile joins the documented filename under the data dir", () => {
    expect(SolanaFundingTool.deployerKeypairFile(dataPath)).toBe(
      Path.join(dataPath, SolanaFundingTool.DeployerKeypairFilename)
    )
  })

  it("createDeployerKeypair persists the keypair on first call", () => {
    const keypairFile = SolanaFundingTool.deployerKeypairFile(dataPath)
    expect(Fs.existsSync(keypairFile)).toBe(false)
    const deployer = SolanaFundingTool.createDeployerKeypair(dataPath)
    expect(Fs.existsSync(keypairFile)).toBe(true)
    // The persisted secret round-trips through the load path as the SAME identity.
    expect(SolanaFundingTool.loadDeployerKeypair(dataPath).publicKey.toBase58()).toBe(deployer.publicKey.toBase58())
  })

  it("createDeployerKeypair is idempotent — a second call returns the SAME identity", () => {
    const first = SolanaFundingTool.createDeployerKeypair(dataPath)
    const second = SolanaFundingTool.createDeployerKeypair(dataPath)
    expect(second.publicKey.toBase58()).toBe(first.publicKey.toBase58())
  })

  it("createDeployerKeypair creates missing parent directories", () => {
    const nested = Path.join(dataPath, "nested", "data")
    const deployer = SolanaFundingTool.createDeployerKeypair(nested)
    expect(Fs.existsSync(SolanaFundingTool.deployerKeypairFile(nested))).toBe(true)
    expect(deployer.publicKey).toBeDefined()
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
    expect(() => SolanaFundingTool.solMintAddress("/no/such/data", 123n)).toThrow(/mock SPL mints not found/)
  })
})
