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
        /program keypair missing.*build:programs/s
      )
      expect(() => SolanaOutpostProgramTool.readIdl(emptyPath)).toThrow(
        /IDL missing.*build:programs/s
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

  it("loadReadOnlyProgram binds the connection with no wallet and camelCases the IDL", () => {
    const programPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-outpost-ro-"))
    try {
      const keypair = Keypair.generate()
      Fs.mkdirSync(Path.join(programPath, "target", "idl"), { recursive: true })
      Fs.writeFileSync(
        SolanaOutpostProgramTool.programIdlFile(programPath),
        JSON.stringify({
          address: keypair.publicKey.toBase58(),
          metadata: { name: "liqsol_core", version: "0.1.0", spec: "0.1.0" },
          instructions: [],
          accounts: [{ name: "GlobalState", discriminator: [0, 1, 2, 3, 4, 5, 6, 7] }],
          types: [
            {
              name: "GlobalState",
              type: { kind: "struct", fields: [{ name: "liq_sequence", type: "u64" }] }
            }
          ]
        })
      )

      const connection = new Connection(rpcUrl),
        program = SolanaOutpostProgramTool.loadReadOnlyProgram(connection, programPath)
      expect(program.programId.toBase58()).toBe(keypair.publicKey.toBase58())
      expect(program.provider.connection).toBe(connection)
      // No wallet: a read never signs, so none is constructed.
      expect(program.provider.publicKey).toBeUndefined()
      // The IDL says `GlobalState` / `liq_sequence`; `anchor.Program` converts
      // both, which is why every coder key in the harness is camelCase.
      expect(Object.keys(program.account)).toEqual(["globalState"])
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
      ).toThrow(/IDL missing.*build:programs/s)
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

describe("SolanaOutpostProgramTool multi-program artifacts", () => {
  let solanaPath: string
  beforeAll(() => {
    solanaPath = Fs.mkdtempSync(Path.join(Os.tmpdir(), "solana-programs-"))
  })
  afterAll(() => {
    Fs.rmSync(solanaPath, { recursive: true, force: true })
  })

  it("names all four genesis programs, defaulting to the OPP outpost host", () => {
    expect(SolanaOutpostProgramTool.AnchorProgram.liqsolCore).toBe(
      SolanaOutpostProgramTool.ProgramName
    )
    expect([...SolanaOutpostProgramTool.GenesisAnchorPrograms]).toEqual([
      "liqsol_core",
      "liqsol_token",
      "transfer_hook",
      "validator_leaderboard"
    ])
  })

  it("composes each program's artifact paths from its crate name", () => {
    const program = SolanaOutpostProgramTool.AnchorProgram.transferHook
    expect(
      SolanaOutpostProgramTool.programKeypairFile(solanaPath, program)
    ).toBe(Path.join(solanaPath, ".keys", "transfer_hook-keypair.json"))
    expect(SolanaOutpostProgramTool.programSoFile(solanaPath, program)).toBe(
      Path.join(solanaPath, "target", "deploy", "transfer_hook.so")
    )
    expect(SolanaOutpostProgramTool.programIdlFile(solanaPath, program)).toBe(
      Path.join(solanaPath, "target", "idl", "transfer_hook.json")
    )
  })

  it("assertIdlProgramId reads the address each IDL declares", () => {
    const program = SolanaOutpostProgramTool.AnchorProgram.liqsolToken,
      declared = Keypair.generate().publicKey
    Fs.mkdirSync(Path.join(solanaPath, "target", "idl"), { recursive: true })
    Fs.writeFileSync(
      SolanaOutpostProgramTool.programIdlFile(solanaPath, program),
      JSON.stringify({
        address: declared.toBase58(),
        metadata: { name: program, version: "0.1.0", spec: "0.1.0" },
        instructions: []
      })
    )
    expect(
      SolanaOutpostProgramTool.assertIdlProgramId(
        solanaPath,
        program
      ).toBase58()
    ).toBe(declared.toBase58())
  })

  it("assertIdlProgramId throws when the IDL declares no address", () => {
    const program = SolanaOutpostProgramTool.AnchorProgram.validatorLeaderboard
    Fs.mkdirSync(Path.join(solanaPath, "target", "idl"), { recursive: true })
    Fs.writeFileSync(
      SolanaOutpostProgramTool.programIdlFile(solanaPath, program),
      JSON.stringify({ metadata: { name: program }, instructions: [] })
    )
    expect(() =>
      SolanaOutpostProgramTool.assertIdlProgramId(solanaPath, program)
    ).toThrow(/declares no address/)
  })
})
