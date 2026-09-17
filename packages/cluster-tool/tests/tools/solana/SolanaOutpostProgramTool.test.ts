import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Connection, Keypair } from "@solana/web3.js"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { SolanaOutpostProgramTool } from "@wireio/cluster-tool/tools/solana"
import { toURL } from "@wireio/cluster-tool/utils"

describe("SolanaOutpostProgramTool", () => {
  let solanaPath: string
  let rpcUrl: string
  beforeAll(async () => {
    solanaPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-outpost-program-"))
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(BindConfigProvider.DefaultSolanaRpc)
    )
  })
  afterAll(() => {
    Fs.rmSync(solanaPath, { recursive: true, force: true })
  })

  it("composes the liqsol_core artifact paths from solanaPath", () => {
    expect(SolanaOutpostProgramTool.programKeypairFile(solanaPath)).toBe(
      Path.join(solanaPath, ".keys", "liqsol_core-keypair.json")
    )
    expect(SolanaOutpostProgramTool.programSoFile(solanaPath)).toBe(
      Path.join(solanaPath, "target", "deploy", "liqsol_core.so")
    )
    expect(SolanaOutpostProgramTool.programIdlFile(solanaPath)).toBe(
      Path.join(solanaPath, "target", "idl", "liqsol_core.json")
    )
  })

  it("derives the program id from the committed keypair", () => {
    const keypair = Keypair.generate()
    Fs.mkdirSync(Path.join(solanaPath, ".keys"), { recursive: true })
    Fs.writeFileSync(
      SolanaOutpostProgramTool.programKeypairFile(solanaPath),
      JSON.stringify([...keypair.secretKey])
    )
    expect(SolanaOutpostProgramTool.programId(solanaPath)?.toBase58()).toBe(
      keypair.publicKey.toBase58()
    )
    expect(SolanaOutpostProgramTool.assertProgramId(solanaPath).toBase58()).toBe(
      keypair.publicKey.toBase58()
    )
  })

  it("parses the generated IDL", () => {
    Fs.mkdirSync(Path.join(solanaPath, "target", "idl"), { recursive: true })
    Fs.writeFileSync(
      SolanaOutpostProgramTool.programIdlFile(solanaPath),
      JSON.stringify({
        metadata: { name: SolanaOutpostProgramTool.ProgramName },
        instructions: [{ name: "epoch_in" }]
      })
    )
    const idl = SolanaOutpostProgramTool.readIdl(solanaPath)
    expect(idl.metadata.name).toBe(SolanaOutpostProgramTool.ProgramName)
  })

  it("returns null / throws with the build remediation when artifacts are absent", () => {
    const emptyPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-outpost-empty-"))
    try {
      expect(SolanaOutpostProgramTool.programId(emptyPath)).toBeNull()
      expect(() => SolanaOutpostProgramTool.assertProgramId(emptyPath)).toThrow(
        /program keypair missing.*patch-idl-errors/s
      )
      expect(() => SolanaOutpostProgramTool.readIdl(emptyPath)).toThrow(
        /IDL missing.*patch-idl-errors/s
      )
    } finally {
      Fs.rmSync(emptyPath, { recursive: true, force: true })
    }
  })

  it("loads ONE Anchor program bound to the connection + signer", () => {
    // Self-contained: stages its own artifacts in a private path rather than
    // mutating the shared `solanaPath`, so this case neither depends on the
    // order of the cases above nor booby-traps any case added after it.
    const programPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-outpost-load-"))
    try {
      const keypair = Keypair.generate()
      Fs.mkdirSync(Path.join(programPath, ".keys"), { recursive: true })
      Fs.writeFileSync(
        SolanaOutpostProgramTool.programKeypairFile(programPath),
        JSON.stringify([...keypair.secretKey])
      )
      Fs.mkdirSync(Path.join(programPath, "target", "idl"), { recursive: true })
      // The IDL's `address` is what Anchor adopts as the program id.
      Fs.writeFileSync(
        SolanaOutpostProgramTool.programIdlFile(programPath),
        JSON.stringify({
          address: keypair.publicKey.toBase58(),
          metadata: { name: "liqsol_core", version: "0.1.0", spec: "0.1.0" },
          instructions: []
        })
      )

      const connection = new Connection(rpcUrl)
      const program = SolanaOutpostProgramTool.loadProgram(
        connection,
        Keypair.generate(),
        programPath
      )
      expect(program.programId.toBase58()).toBe(keypair.publicKey.toBase58())
      expect(program.provider.connection).toBe(connection)
    } finally {
      Fs.rmSync(programPath, { recursive: true, force: true })
    }
  })

  it("loadProgram carries the build remediation when the IDL is absent", () => {
    const emptyPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-outpost-noidl-"))
    try {
      expect(() =>
        SolanaOutpostProgramTool.loadProgram(
          new Connection(rpcUrl),
          Keypair.generate(),
          emptyPath
        )
      ).toThrow(/IDL missing.*patch-idl-errors/s)
    } finally {
      Fs.rmSync(emptyPath, { recursive: true, force: true })
    }
  })

  it("throws on a malformed IDL file", () => {
    const brokenPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-outpost-broken-"))
    try {
      Fs.mkdirSync(Path.join(brokenPath, "target", "idl"), { recursive: true })
      Fs.writeFileSync(SolanaOutpostProgramTool.programIdlFile(brokenPath), "{not-json")
      expect(() => SolanaOutpostProgramTool.readIdl(brokenPath)).toThrow()
    } finally {
      Fs.rmSync(brokenPath, { recursive: true, force: true })
    }
  })
})
