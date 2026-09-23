import { execFileSync } from "node:child_process"
import Crypto from "node:crypto"
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

  describe("assertProgramSoFile", () => {
    /** Write a `.so` plus a manifest recording `recordedBytes` for it. */
    function writeProgramArtifacts(
      root: string,
      soBytes: Buffer,
      recordedBytes: Buffer = soBytes,
      sourceDescribe: string = SolanaOutpostProgramTool.describeCheckout(root)
    ): void {
      Fs.mkdirSync(Path.join(root, "target", "deploy"), { recursive: true })
      Fs.writeFileSync(SolanaOutpostProgramTool.programSoFile(root), soBytes)
      Fs.writeFileSync(
        SolanaOutpostProgramTool.buildManifestFile(root),
        JSON.stringify({
          schemaVersion: 1,
          arch: "v3",
          sourceDescribe,
          programs: {
            [SolanaOutpostProgramTool.ProgramName]: {
              programBinaryPath: SolanaOutpostProgramTool.ProgramSoSubpath,
              programBinaryLength: recordedBytes.length,
              programBinarySha256: Crypto.createHash("sha256")
                .update(recordedBytes)
                .digest("hex")
            }
          }
        })
      )
    }

    /**
     * Run `body` against a throwaway wire-solana root that is a real git repo
     * with one commit — `describeCheckout` shells out to git, so the fixture
     * has to be describable.
     */
    function withRoot(prefix: string, body: (root: string) => void): void {
      const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), prefix))
      try {
        const git = (...args: string[]) =>
          execFileSync("git", args, { cwd: root, stdio: "ignore" })
        git("init", "--quiet")
        git("config", "user.email", "harness@wire.test")
        git("config", "user.name", "harness")
        Fs.writeFileSync(Path.join(root, "Anchor.toml"), "[toolchain]\n")
        git("add", "-A")
        git("commit", "--quiet", "-m", "fixture")
        body(root)
      } finally {
        Fs.rmSync(root, { recursive: true, force: true })
      }
    }

    it("returns the .so path when it matches the recorded build", () => {
      withRoot("solana-outpost-so-ok-", root => {
        writeProgramArtifacts(root, Buffer.from("compiled-liqsol-core"))
        expect(SolanaOutpostProgramTool.assertProgramSoFile(root)).toBe(
          SolanaOutpostProgramTool.programSoFile(root)
        )
        expect(SolanaOutpostProgramTool.readBuildManifest(root).arch).toBe("v3")
      })
    })

    it("REJECTS a .so whose sha256 differs from the manifest (the stale-binary case)", () => {
      withRoot("solana-outpost-so-stale-", root => {
        writeProgramArtifacts(
          root,
          Buffer.from("binary-from-another-branch"),
          Buffer.from("binary-the-build-emitted")
        )
        expect(() => SolanaOutpostProgramTool.assertProgramSoFile(root)).toThrow(
          /does not match the recorded SBPF v3 build.*build:programs/s
        )
      })
    })

    it("REJECTS a binary built from a different checkout (the branch-switch case)", () => {
      withRoot("solana-outpost-so-checkout-", root => {
        // The .so and its manifest agree with EACH OTHER — only the checkout
        // they were built from has moved on, which a sha-only check misses.
        writeProgramArtifacts(
          root,
          Buffer.from("compiled-liqsol-core"),
          Buffer.from("compiled-liqsol-core"),
          "devnet-v1.5.2-100-gdeadbee"
        )
        expect(() => SolanaOutpostProgramTool.assertProgramSoFile(root)).toThrow(
          /built from a different checkout.*devnet-v1\.5\.2-100-gdeadbee/s
        )
      })
    })

    it("accepts a dirty build but reports it as unverifiable", () => {
      withRoot("solana-outpost-so-dirty-", root => {
        // Modify a TRACKED file so the checkout really describes as dirty.
        Fs.appendFileSync(Path.join(root, "Anchor.toml"), "# edited\n")
        const dirty = SolanaOutpostProgramTool.describeCheckout(root)
        expect(dirty).toMatch(
          new RegExp(`${SolanaOutpostProgramTool.DirtyDescribeSuffix}$`)
        )

        writeProgramArtifacts(root, Buffer.from("dirty-build"), undefined, dirty)
        expect(SolanaOutpostProgramTool.assertProgramSoFile(root)).toBe(
          SolanaOutpostProgramTool.programSoFile(root)
        )
      })
    })

    it("throws when the checkout cannot be described", () => {
      const notARepo = Fs.mkdtempSync(
        Path.join(Os.tmpdir(), "solana-outpost-nogit-")
      )
      try {
        expect(() =>
          SolanaOutpostProgramTool.describeCheckout(notARepo)
        ).toThrow(/could not describe the wire-solana checkout/s)
      } finally {
        Fs.rmSync(notARepo, { recursive: true, force: true })
      }
    })

    it("throws when the .so, the manifest, or its program entry is absent", () => {
      withRoot("solana-outpost-so-missing-", root => {
        expect(() => SolanaOutpostProgramTool.assertProgramSoFile(root)).toThrow(
          /\.so missing.*build:programs/s
        )

        Fs.mkdirSync(Path.join(root, "target", "deploy"), { recursive: true })
        Fs.writeFileSync(SolanaOutpostProgramTool.programSoFile(root), "so")
        expect(() => SolanaOutpostProgramTool.assertProgramSoFile(root)).toThrow(
          /build manifest missing.*build:programs/s
        )

        Fs.writeFileSync(
          SolanaOutpostProgramTool.buildManifestFile(root),
          JSON.stringify({ schemaVersion: 1, arch: "v3", programs: {} })
        )
        expect(() => SolanaOutpostProgramTool.assertProgramSoFile(root)).toThrow(
          /build manifest has no liqsol_core entry/s
        )
      })
    })
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
