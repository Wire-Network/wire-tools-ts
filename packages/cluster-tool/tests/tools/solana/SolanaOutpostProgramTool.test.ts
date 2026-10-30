import { execFileSync } from "node:child_process"
import Crypto from "node:crypto"
import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Connection, Keypair } from "@solana/web3.js"
import {
  BindConfigProvider,
  DaemonConfig,
  DaemonKind,
  StartScriptRenderer
} from "@wireio/cluster-tool/config"
import { SolanaOutpostProgramTool } from "@wireio/cluster-tool/tools/solana"
import { StartScriptVariable, toURL } from "@wireio/cluster-tool/utils"

describe("SolanaOutpostProgramTool", () => {
  let solanaPath: string
  let rpcUrl: string
  beforeAll(async () => {
    solanaPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "solana-outpost-program-")
    )
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultSolanaRpc
      )
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
    expect(
      SolanaOutpostProgramTool.assertProgramId(solanaPath).toBase58()
    ).toBe(keypair.publicKey.toBase58())
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
    const emptyPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "solana-outpost-empty-")
    )
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
    const programPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "solana-outpost-load-")
    )
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
    const programPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "solana-outpost-ro-")
    )
    try {
      const keypair = Keypair.generate()
      Fs.mkdirSync(Path.join(programPath, "target", "idl"), { recursive: true })
      Fs.writeFileSync(
        SolanaOutpostProgramTool.programIdlFile(programPath),
        JSON.stringify({
          address: keypair.publicKey.toBase58(),
          metadata: { name: "liqsol_core", version: "0.1.0", spec: "0.1.0" },
          instructions: [],
          accounts: [
            { name: "GlobalState", discriminator: [0, 1, 2, 3, 4, 5, 6, 7] }
          ],
          types: [
            {
              name: "GlobalState",
              type: {
                kind: "struct",
                fields: [{ name: "liq_sequence", type: "u64" }]
              }
            }
          ]
        })
      )

      const connection = new Connection(rpcUrl),
        program = SolanaOutpostProgramTool.loadReadOnlyProgram(
          connection,
          programPath
        )
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
    const emptyPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "solana-outpost-noidl-")
    )
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

  describe("readVerifiedPrograms", () => {
    /** Describe a fixture checkout using the manifest producer's command. */
    function describeCheckout(root: string): string {
      return execFileSync(
        "git",
        ["describe", "--tags", "--always", "--dirty"],
        {
          cwd: root,
          encoding: "utf8"
        }
      ).trim()
    }

    /** Write a `.so` plus a manifest recording `recordedBytes` for it. */
    function writeProgramArtifacts(
      root: string,
      soBytes: Buffer,
      recordedBytes: Buffer = soBytes,
      sourceDescribe: string = describeCheckout(root),
      program: SolanaOutpostProgramTool.AnchorProgram = SolanaOutpostProgramTool.ProgramName
    ): void {
      Fs.mkdirSync(Path.join(root, "target", "deploy"), { recursive: true })
      Fs.writeFileSync(
        SolanaOutpostProgramTool.programSoFile(root, program),
        soBytes
      )
      Fs.writeFileSync(
        SolanaOutpostProgramTool.buildManifestFile(root),
        JSON.stringify({
          schemaVersion: 1,
          arch: "v3",
          sourceDescribe,
          programs: {
            [program]: {
              programBinaryPath: Path.relative(
                root,
                SolanaOutpostProgramTool.programSoFile(root, program)
              ),
              programBinaryLength: recordedBytes.length,
              programBinarySha256: Crypto.createHash("sha256")
                .update(recordedBytes)
                .digest("hex")
            }
          }
        })
      )
    }

    /** Corrupt each trusted manifest field while retaining the other valid fields. */
    function invalidManifestTexts(validText: string): string[] {
      const manifest = JSON.parse(validText),
        program = SolanaOutpostProgramTool.ProgramName,
        topLevelFields = [
          { schemaVersion: undefined },
          { schemaVersion: 999 },
          { schemaVersion: "1" },
          { arch: undefined },
          { arch: 3 },
          { arch: "" },
          { sourceDescribe: undefined },
          { sourceDescribe: 123 },
          { sourceDescribe: "" },
          { programs: null },
          { programs: [] }
        ],
        programFields = [
          { programBinaryPath: undefined },
          { programBinaryPath: "" },
          { programBinaryLength: undefined },
          { programBinaryLength: "23" },
          { programBinaryLength: -1 },
          { programBinaryLength: 1.5 },
          { programBinarySha256: undefined },
          { programBinarySha256: "not-a-sha256" }
        ]
      return [
        "{not-json",
        "null",
        "[]",
        ...topLevelFields.map(fields =>
          JSON.stringify({ ...manifest, ...fields })
        ),
        ...[null, []].map(entry =>
          JSON.stringify({ ...manifest, programs: { [program]: entry } })
        ),
        ...programFields.map(fields =>
          JSON.stringify({
            ...manifest,
            programs: {
              [program]: { ...manifest.programs[program], ...fields }
            }
          })
        )
      ]
    }

    it("rejects malformed manifests with a build remediation error", () => {
      withRoot("solana-invalid-manifest-", root => {
        writeProgramArtifacts(root, Buffer.from("compiled-liqsol-core"))
        const manifestFile = SolanaOutpostProgramTool.buildManifestFile(root),
          invalidTexts = invalidManifestTexts(
            Fs.readFileSync(manifestFile, "utf8")
          )
        invalidTexts.forEach(text => {
          Fs.writeFileSync(manifestFile, text)
          expect(() =>
            SolanaOutpostProgramTool.readVerifiedPrograms(root, [
              SolanaOutpostProgramTool.ProgramName
            ])
          ).toThrow(/invalid build manifest.*build:programs/s)
        })
      })
    })

    /**
     * Run `body` against a throwaway wire-solana root that is a real git repo
     * with one commit — `describeCheckout` shells out to git, so the fixture
     * has to be describable.
     */
    function withRoot(prefix: string, body: (root: string) => void): void {
      const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), prefix))
      try {
        const git = (...args: string[]) =>
          execFileSync(
            "git",
            [
              "-c",
              "commit.gpgSign=false",
              "-c",
              "core.hooksPath=/dev/null",
              ...args
            ],
            {
              cwd: root,
              stdio: "pipe",
              env: {
                ...process.env,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_COUNT: "0",
                GIT_CONFIG_PARAMETERS: ""
              }
            }
          )
        git("init")
        git("config", "user.email", "harness@wire.test")
        git("config", "user.name", "harness")
        Fs.writeFileSync(Path.join(root, "Anchor.toml"), "[toolchain]\n")
        git("add", "-A")
        git("commit", "-m", "fixture")
        body(root)
      } finally {
        Fs.rmSync(root, { recursive: true, force: true })
      }
    }

    it("creates Git fixtures despite hostile signing and global hooks configuration", () => {
      const configPath = Fs.mkdtempSync(
          Path.join(Os.tmpdir(), "solana-hostile-git-")
        ),
        hooksPath = Path.join(configPath, "hooks"),
        configFile = Path.join(configPath, "gitconfig"),
        previousEnvironment = process.env
      Fs.mkdirSync(hooksPath)
      Fs.writeFileSync(
        Path.join(hooksPath, "pre-commit"),
        "#!/bin/sh\nexit 1\n",
        { mode: 0o755 }
      )
      Fs.writeFileSync(
        configFile,
        `[commit]\n  gpgSign = true\n[core]\n  hooksPath = ${hooksPath}\n[gpg]\n  program = /no/such/signer\n`
      )
      process.env = {
        ...previousEnvironment,
        GIT_CONFIG_GLOBAL: configFile,
        GIT_CONFIG_SYSTEM: configFile
      }
      try {
        withRoot("solana-isolated-git-", root => {
          expect(describeCheckout(root)).toMatch(/^[0-9a-f]+$/)
        })
      } finally {
        process.env = previousEnvironment
        Fs.rmSync(configPath, { recursive: true, force: true })
      }
    })

    it("returns verified bytes and provenance when they match the recorded build", () => {
      withRoot("solana-outpost-so-ok-", root => {
        writeProgramArtifacts(root, Buffer.from("compiled-liqsol-core"))
        expect(
          SolanaOutpostProgramTool.readVerifiedPrograms(root, [
            SolanaOutpostProgramTool.ProgramName
          ])
        ).toEqual({
          binaries: [Buffer.from("compiled-liqsol-core")],
          sourceDescribe: describeCheckout(root)
        })
      })
    })

    it.each(SolanaOutpostProgramTool.GenesisAnchorPrograms)(
      "verifies %s against its own manifest entry",
      program => {
        withRoot("solana-program-manifest-", root => {
          writeProgramArtifacts(
            root,
            Buffer.from(program),
            undefined,
            undefined,
            program
          )
          expect(
            SolanaOutpostProgramTool.readVerifiedPrograms(root, [program])
          ).toEqual({
            binaries: [Buffer.from(program)],
            sourceDescribe: describeCheckout(root)
          })
          Fs.appendFileSync(
            SolanaOutpostProgramTool.programSoFile(root, program),
            "stale"
          )
          expect(() =>
            SolanaOutpostProgramTool.readVerifiedPrograms(root, [program])
          ).toThrow(/does not match the recorded SBPF v3 build/)
        })
      }
    )

    it("REJECTS a .so whose sha256 differs from the manifest (the stale-binary case)", () => {
      withRoot("solana-outpost-so-stale-", root => {
        writeProgramArtifacts(
          root,
          Buffer.from("binary-from-another-branch"),
          Buffer.from("binary-the-build-emitted")
        )
        expect(() =>
          SolanaOutpostProgramTool.readVerifiedPrograms(root, [
            SolanaOutpostProgramTool.ProgramName
          ])
        ).toThrow(/does not match the recorded SBPF v3 build.*build:programs/s)
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
        expect(() =>
          SolanaOutpostProgramTool.readVerifiedPrograms(root, [
            SolanaOutpostProgramTool.ProgramName
          ])
        ).toThrow(
          /built from a different checkout.*devnet-v1\.5\.2-100-gdeadbee/s
        )
      })
    })

    it("accepts the same commit with different abbreviations and tag inventories", () => {
      withRoot("solana-display-stamp-", root => {
        execFileSync("git", ["-c", "tag.gpgSign=false", "tag", "fixture-tag"], {
          cwd: root
        })
        writeProgramArtifacts(
          root,
          Buffer.from("same-build"),
          undefined,
          execFileSync(
            "git",
            ["-c", "core.abbrev=7", "describe", "--tags", "--always", "--long"],
            { cwd: root, encoding: "utf8" }
          ).trim()
        )
        execFileSync("git", ["config", "core.abbrev", "12"], { cwd: root })
        execFileSync("git", ["tag", "-d", "fixture-tag"], { cwd: root })
        expect(
          SolanaOutpostProgramTool.readVerifiedPrograms(root, [
            SolanaOutpostProgramTool.ProgramName
          ])
        ).toMatchObject({ binaries: [Buffer.from("same-build")] })
      })
    })

    it("reads one manifest and retains verified bytes across shared-output replacement", () => {
      withRoot("solana-verified-bytes-", root => {
        const bytes = Buffer.from("verified-build")
        writeProgramArtifacts(root, bytes)
        const verified = SolanaOutpostProgramTool.readVerifiedPrograms(root, [
          SolanaOutpostProgramTool.ProgramName
        ])
        Fs.writeFileSync(
          SolanaOutpostProgramTool.programSoFile(root),
          "replacement"
        )
        Fs.unlinkSync(SolanaOutpostProgramTool.buildManifestFile(root))
        expect(verified.binaries).toEqual([bytes])
      })
    })

    it.each([false, true])(
      "generated start.sh verifies at execution and deploys the private bytes (dirty: %s)",
      dirty => {
        withRoot("solana-runtime-script-", root => {
          const clusterPath = Path.join(root, "cluster"),
            daemonPath = Path.join(
              clusterPath,
              "data",
              "solana_test_validator"
            ),
            scriptFile = Path.join(daemonPath, "start.sh"),
            stubFile = Path.join(root, "validator-stub"),
            bytes = Buffer.from("verified-program"),
            soFile = SolanaOutpostProgramTool.programSoFile(root)
          Fs.mkdirSync(daemonPath, { recursive: true })
          Fs.writeFileSync(Path.join(clusterPath, "cluster-config.json"), "{}")
          Fs.writeFileSync(
            stubFile,
            `#!/usr/bin/env bash\nset -eu\nprintf "replacement" > "$${StartScriptVariable.WIRE_SOLANA_PATH}/target/deploy/liqsol_core.so"\ncat "$2"\n`
          )
          Fs.chmodSync(stubFile, 0o755)
          const daemon: DaemonConfig = {
              kind: DaemonKind.solanaValidator,
              label: "solana-test-validator",
              daemonPath,
              exe: stubFile,
              argv: ["--bpf-program", soFile],
              conditions: [],
              relocations: [],
              solanaPrograms: [
                {
                  name: SolanaOutpostProgramTool.ProgramName,
                  programId: "fixture",
                  soFile
                }
              ]
            },
            script = new StartScriptRenderer(daemon, [
              { prefix: root, variable: StartScriptVariable.WIRE_SOLANA_PATH }
            ]).render()
          // Rendering is valid BEFORE any local build artifacts exist.
          Fs.writeFileSync(scriptFile, script)
          expect(script.indexOf("WIRE_SOLANA_BUILD_CHECK")).toBeLessThan(
            script.indexOf("exec ")
          )
          expect(script).toContain(
            `"\${${DaemonConfig.NodeBinEnvironmentVariable}:-$(command -v ${DaemonConfig.NodeExecutable})}" - "$${StartScriptVariable.WIRE_SOLANA_PATH}" "$${StartScriptVariable.NODE_DIR}"`
          )
          const environment = {
            ...process.env,
            [StartScriptVariable.WIRE_SOLANA_PATH]: root,
            WIRE_CLUSTER_DIR: clusterPath,
            [DaemonConfig.NodeBinEnvironmentVariable]: process.execPath,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_COUNT: "0"
          }
          expect(() =>
            execFileSync("bash", [scriptFile], {
              env: environment,
              stdio: "pipe"
            })
          ).toThrow()
          if (dirty)
            Fs.appendFileSync(Path.join(root, "Anchor.toml"), "# edited\n")
          writeProgramArtifacts(root, bytes)
          const manifestFile = SolanaOutpostProgramTool.buildManifestFile(root),
            validManifest = Fs.readFileSync(manifestFile, "utf8")
          invalidManifestTexts(validManifest).forEach(text => {
            Fs.writeFileSync(manifestFile, text)
            expect(() =>
              execFileSync("bash", [scriptFile], {
                env: environment,
                stdio: "pipe"
              })
            ).toThrow(/invalid build manifest.*build:programs/s)
            // The stub mutates this file, so unchanged bytes prove it never ran.
            expect(Fs.readFileSync(soFile)).toEqual(bytes)
          })
          Fs.writeFileSync(manifestFile, validManifest)
          expect(
            execFileSync("bash", [scriptFile], { env: environment })
          ).toEqual(bytes)
          expect(Fs.readFileSync(soFile, "utf8")).toBe("replacement")
          // The manifest still names the verified build, so another launch refuses
          // the replacement BEFORE it can exec the stub.
          const marker = "invalid-replacement"
          Fs.writeFileSync(soFile, marker)
          expect(() =>
            execFileSync("bash", [scriptFile], {
              env: environment,
              stdio: "pipe"
            })
          ).toThrow()
          expect(Fs.readFileSync(soFile, "utf8")).toBe(marker)
        })
      }
    )

    it("accepts a dirty build but reports it as unverifiable", () => {
      withRoot("solana-outpost-so-dirty-", root => {
        // Modify a TRACKED file so the checkout really describes as dirty.
        Fs.appendFileSync(Path.join(root, "Anchor.toml"), "# edited\n")
        const dirty = describeCheckout(root)
        expect(dirty).toMatch(
          new RegExp(`${SolanaOutpostProgramTool.DirtyDescribeSuffix}$`)
        )

        writeProgramArtifacts(
          root,
          Buffer.from("dirty-build"),
          undefined,
          dirty
        )
        expect(
          SolanaOutpostProgramTool.readVerifiedPrograms(root, [
            SolanaOutpostProgramTool.ProgramName
          ])
        ).toEqual({
          binaries: [Buffer.from("dirty-build")],
          sourceDescribe: dirty
        })
      })
    })

    it("throws when the .so, the manifest, or its program entry is absent", () => {
      withRoot("solana-outpost-so-missing-", root => {
        expect(() =>
          SolanaOutpostProgramTool.readVerifiedPrograms(root, [
            SolanaOutpostProgramTool.ProgramName
          ])
        ).toThrow(/\.so missing.*build:programs/s)

        Fs.mkdirSync(Path.join(root, "target", "deploy"), { recursive: true })
        Fs.writeFileSync(SolanaOutpostProgramTool.programSoFile(root), "so")
        expect(() =>
          SolanaOutpostProgramTool.readVerifiedPrograms(root, [
            SolanaOutpostProgramTool.ProgramName
          ])
        ).toThrow(/build manifest missing.*build:programs/s)

        Fs.writeFileSync(
          SolanaOutpostProgramTool.buildManifestFile(root),
          JSON.stringify({
            schemaVersion: 1,
            arch: "v3",
            sourceDescribe: describeCheckout(root),
            programs: {}
          })
        )
        expect(() =>
          SolanaOutpostProgramTool.readVerifiedPrograms(root, [
            SolanaOutpostProgramTool.ProgramName
          ])
        ).toThrow(/invalid build manifest.*missing liqsol_core entry/s)
      })
    })
  })

  it("throws on a malformed IDL file", () => {
    const brokenPath = Fs.mkdtempSync(
      Path.join(Os.tmpdir(), "solana-outpost-broken-")
    )
    try {
      Fs.mkdirSync(Path.join(brokenPath, "target", "idl"), { recursive: true })
      Fs.writeFileSync(
        SolanaOutpostProgramTool.programIdlFile(brokenPath),
        "{not-json"
      )
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
