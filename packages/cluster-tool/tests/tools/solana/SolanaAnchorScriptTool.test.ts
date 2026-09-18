import Path from "node:path"

import { SolanaAnchorScriptTool } from "@wireio/cluster-tool/tools/solana"
import { BindConfigProvider } from "@wireio/cluster-tool/config"
import { Report } from "@wireio/cluster-tool/report"
import { toURL } from "@wireio/cluster-tool/utils"

/** The wallet file the argv carries — a path, never dialed or read here. */
const WalletFile = "/cluster/data/sol-deployer-keypair.json"
/** The `Anchor.toml` `[scripts]` key exercised by every case below. */
const Script = "init-global-config"

describe("SolanaAnchorScriptTool", () => {
  // The argv carries the validator's RPC URL, so the port is registry-issued
  // even though nothing binds it in this suite.
  let rpcUrl: string
  beforeAll(async () => {
    rpcUrl = toURL(
      await BindConfigProvider.findAvailable(
        BindConfigProvider.DefaultSolanaRpc
      )
    )
  })

  describe("buildArgs", () => {
    it("passes the cluster + wallet overrides and no separator without args", () => {
      expect(
        SolanaAnchorScriptTool.buildArgs(Script, [], rpcUrl, WalletFile)
      ).toEqual([
        SolanaAnchorScriptTool.RunSubcommand,
        Script,
        SolanaAnchorScriptTool.ClusterFlag,
        rpcUrl,
        SolanaAnchorScriptTool.WalletFlag,
        WalletFile
      ])
    })

    it("forwards positional arguments after the separator", () => {
      const args = SolanaAnchorScriptTool.buildArgs(
        "fund-treasury",
        ["1000000000"],
        rpcUrl,
        WalletFile
      )
      expect(args.slice(-2)).toEqual([
        SolanaAnchorScriptTool.ArgumentSeparator,
        "1000000000"
      ])
      expect(args.indexOf(SolanaAnchorScriptTool.ArgumentSeparator)).toBe(
        args.length - 2
      )
    })
  })

  describe("scriptEnvironment", () => {
    /**
     * Run `body` with `PATH` set to `value`, or UNSET when it is null, and
     * restore the caller's exactly — including its absence, which
     * `process.env.PATH = undefined` would turn into the string "undefined".
     */
    function withPath(value: string, body: () => void): void {
      const { PATH: inherited } = process.env,
        had = "PATH" in process.env
      try {
        if (value == null) delete process.env.PATH
        else process.env.PATH = value
        body()
      } finally {
        if (had) process.env.PATH = inherited
        else delete process.env.PATH
      }
    }

    it("puts wire-solana's own node_modules/.bin FIRST on PATH", () => {
      // PATH is PINNED rather than read from the environment: with none set
      // there is no delimiter to find, and the assertion would fail for a
      // reason that has nothing to do with the ordering under test.
      const inherited = ["/usr/bin", "/bin"].join(Path.delimiter)
      withPath(inherited, () => {
        const solanaPath = "/repos/wire-solana",
          env = SolanaAnchorScriptTool.scriptEnvironment(solanaPath),
          expected = Path.join(
            solanaPath,
            SolanaAnchorScriptTool.NodeBinSubdirectory
          )
        // The bin dir leads; the caller's PATH is kept behind it, not replaced
        // — the scripts still need `solana`, `anchor` and the host toolchain.
        expect(env.PATH).toBe(`${expected}${Path.delimiter}${inherited}`)
      })
    })

    it("adds no trailing delimiter when the caller has no PATH", () => {
      // An empty PATH entry is the CURRENT DIRECTORY on POSIX — not somewhere a
      // script subprocess should resolve a binary from.
      withPath(null, () => {
        const env = SolanaAnchorScriptTool.scriptEnvironment("/repos/wire-solana")
        expect(env.PATH).toBe(
          Path.join("/repos/wire-solana", SolanaAnchorScriptTool.NodeBinSubdirectory)
        )
        expect(env.PATH.endsWith(Path.delimiter)).toBe(false)
      })
    })

    it("carries the rest of the caller's environment through", () => {
      const env = SolanaAnchorScriptTool.scriptEnvironment("/repos/wire-solana")
      Object.entries(process.env)
        .filter(([name]) => name !== "PATH")
        .forEach(([name, value]) => expect(env[name]).toBe(value))
    })

    it("names the bin subdirectory rather than spelling it at the call site", () => {
      expect(SolanaAnchorScriptTool.NodeBinSubdirectory).toBe(
        Path.join("node_modules", ".bin")
      )
    })
  })

  describe("outputExtra", () => {
    it("keeps the TAIL of each stream, which is where a script's verdict is", () => {
      const verdict = "Successfully initialized wire config.",
        stdout = `${"setup chatter\n".repeat(1_000)}${verdict}`,
        entry = SolanaAnchorScriptTool.outputExtra(
          "init-wire-config",
          stdout,
          ""
        )
      expect(entry.client).toBe("process")
      expect(entry.kind).toBe("exec-output")
      expect(entry.script).toBe("init-wire-config")
      expect(entry.stderr).toBe("")
      expect(String(entry.stdout)).toHaveLength(
        SolanaAnchorScriptTool.OutputTailChars
      )
      // The head is dropped; the verdict survives — that is the whole point.
      expect(String(entry.stdout).endsWith(verdict)).toBe(true)
    })

    it("carries a short stream whole and an empty one as an empty string", () => {
      const entry = SolanaAnchorScriptTool.outputExtra("init-distro", "ok", "")
      expect(entry.stdout).toBe("ok")
      expect(entry.stderr).toBe("")
    })
  })

  describe("planRun", () => {
    it("builds a typed step carrying the script + args and a named runner", () => {
      const step = SolanaAnchorScriptTool.planRun(
        Report.Actor.SolanaOutpost,
        Script,
        "create the liqsol global_config",
        {},
        Script,
        ["--force"]
      )
      expect(step.actor).toBe(Report.Actor.SolanaOutpost)
      expect(step.input).toEqual({
        kind: "SolanaAnchorScriptTool.RunInput",
        script: Script,
        scriptArgs: ["--force"]
      })
      expect(step.runner).toBe(SolanaAnchorScriptTool.runScript)
    })

    it("defaults to no script arguments", () => {
      const step = SolanaAnchorScriptTool.planRun(
        Report.Actor.SolanaOutpost,
        Script,
        "create the liqsol global_config",
        {},
        Script
      )
      expect(step.input.scriptArgs).toEqual([])
    })
  })
})
