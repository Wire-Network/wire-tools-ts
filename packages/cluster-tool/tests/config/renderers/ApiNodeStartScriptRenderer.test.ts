import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { execFileSync, type SpawnSyncReturns } from "node:child_process"
import { Either } from "@3fv/prelude-ts"
import { NodeopProcess } from "@wireio/cluster-tool/cluster/processes"
import {
  ApiNodeConfig,
  ApiNodeStartScriptRenderer,
  type ApiNodeOptions,
  ClusterConfigProvider,
  StartScriptRenderer
} from "@wireio/cluster-tool/config"
import { StartScriptVariable } from "@wireio/cluster-tool/utils"

const HttpServerAddress = "0.0.0.0:8888"
/** Mode of the stub nodeop shim + the script under test. */
const ExecutableMode = 0o755

describe("ApiNodeStartScriptRenderer", () => {
  let dir: string
  let prefixPath: string
  let traceAwarePrefixPath: string
  let bashPath: string

  /**
   * Write an exec-capturing nodeop shim under `<root>/bin/nodeop` — the
   * rendered script `exec`s it, so whatever it prints IS the argv the script
   * would have spawned. When `advertisesTraceNoAbis`, its `--help` names the
   * flag, which is exactly what the rendered capability probe greps for.
   */
  function writeNodeopShim(root: string, advertisesTraceNoAbis: boolean): void {
    Fs.mkdirSync(Path.join(root, ClusterConfigProvider.BinSubpath), {
      recursive: true
    })
    const stub = Path.join(root, ClusterConfigProvider.BinSubpath, "nodeop"),
      help = advertisesTraceNoAbis
        ? `if [ "$1" = "${NodeopProcess.HelpFlag}" ]; then printf "%s\\n" "  ${NodeopProcess.TraceNoAbisFlag}   serve raw traces"; exit 0; fi\n`
        : ""
    Fs.writeFileSync(
      stub,
      `#!/usr/bin/env bash\n${help}for arg in "$@"; do printf "%s\\n" "$arg"; done\n`
    )
    Fs.chmodSync(stub, ExecutableMode)
  }

  beforeAll(() => {
    // Resolved ONCE under the normal environment, so the PATH-less failure case
    // below can still invoke an interpreter.
    bashPath = execFileSync("sh", ["-c", "command -v bash"], {
      encoding: "utf8"
    }).trim()
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "api-node-start-"))
    prefixPath = Path.join(dir, "prefix")
    writeNodeopShim(prefixPath, false)
    // A SECOND prefix whose nodeop generation DOES know --trace-no-abis, so the
    // rendered probe has both answers to give.
    traceAwarePrefixPath = Path.join(dir, "prefix-trace")
    writeNodeopShim(traceAwarePrefixPath, true)
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Render the script for `overrides` merged over the minimum valid options. */
  function render(overrides: ApiNodeOptions = {}): string {
    return new ApiNodeStartScriptRenderer(
      ApiNodeConfig.resolve({
        outputPath: Path.join(dir, "out"),
        httpServerAddress: HttpServerAddress,
        ...overrides
      })
    ).render()
  }

  /**
   * Write the script into its own directory and RUN it — the argv the shim
   * prints is what a real nodeop would have received.
   */
  function runScript(
    name: string,
    overrides: ApiNodeOptions = {},
    prefix: string = prefixPath
  ): string[] {
    const nodePath = Path.join(dir, name)
    Fs.mkdirSync(nodePath, { recursive: true })
    const scriptFile = Path.join(nodePath, "start.sh")
    Fs.writeFileSync(scriptFile, render(overrides))
    return execFileSync("bash", [scriptFile], {
      encoding: "utf8",
      env: {
        ...global.process.env,
        // The EXPLICIT variable, not WIRE_BUILD_PATH: resolution prefers a
        // `nodeop` on PATH over that fallback, so an ambient nodeop on the
        // runner would otherwise resolve a different prefix.
        WIRE_PREFIX_PATH: prefix
      }
    })
      .split("\n")
      .filter(line => line.length > 0)
  }

  /**
   * Run the script with no resolvable prefix and hand back whatever it wrote to
   * stderr — `execFileSync` folds a non-zero exit into a throw whose payload
   * carries the captured streams.
   */
  function captureFailure(scriptFile: string, emptyPath: string): string {
    return Either.try(() =>
      execFileSync(bashPath, [scriptFile], {
        encoding: "utf8",
        stdio: "pipe",
        env: { PATH: emptyPath }
      })
    ).match({
      // execFileSync throws an Error CARRYING the captured streams.
      Left: error => String((error as Error & SpawnSyncReturns<string>).stderr),
      Right: () => ""
    })
  }

  it("opens with the shared shebang + strict mode", () => {
    const lines = render().split("\n")
    expect(lines[0]).toBe(StartScriptRenderer.Shebang)
    expect(lines[1]).toBe(StartScriptRenderer.StrictMode)
  })

  it("carries its own header, never the cluster script's `wire-cluster-tool run` one", () => {
    const script = render()
    expect(script).toContain(ApiNodeStartScriptRenderer.HeaderComment[0])
    expect(script).toContain("./start.sh")
    expect(script).not.toContain("wire-cluster-tool run")
  })

  it("derives $NODE_DIR from BASH_SOURCE and has NO cluster preamble", () => {
    const script = render()
    expect(script).toContain(ApiNodeStartScriptRenderer.NodeDirLine)
    // A standalone node has no cluster root above it: no CLUSTER_DIR and no
    // cluster-config.json probe. (The CONDITIONAL_ARGS block IS shared — see
    // the capability-probe suite below.)
    expect(script).not.toContain(StartScriptVariable.CLUSTER_DIR)
    expect(script).not.toContain("cluster-config.json")
  })

  describe("--trace-no-abis capability probe", () => {
    // This node loads trace_api_plugin, and newer nodeop generations hard-fail
    // that plugin's init WITHOUT the flag while older ones reject the unknown
    // option WITH it. `create-api-node` never sees a nodeop binary, so the
    // answer must be computed on the host that RUNS the script.
    it("renders the shared conditional block with the probe test", () => {
      const script = render()
      expect(script).toContain(`${StartScriptRenderer.ConditionalArrayName}=()`)
      expect(script).toContain(
        NodeopProcess.traceNoAbisProbeTest(
          ApiNodeStartScriptRenderer.execTarget()
        )
      )
      expect(script).toContain(
        `${StartScriptRenderer.ConditionalArrayName}+=('${NodeopProcess.TraceNoAbisFlag}')`
      )
      expect(script).toContain(StartScriptRenderer.ConditionalArrayExpansion)
    })

    it("declares + populates the array BEFORE the exec that expands it", () => {
      const lines = render().split("\n"),
        declaration = lines.findIndex(line =>
          line.startsWith(`${StartScriptRenderer.ConditionalArrayName}=()`)
        ),
        probe = lines.findIndex(line =>
          line.includes(
            `${StartScriptRenderer.ConditionalArrayName}+=('${NodeopProcess.TraceNoAbisFlag}')`
          )
        ),
        exec = lines.findIndex(line => line.startsWith("exec "))
      // A block emitted after the exec would never run — the exec replaces the
      // shell — so the ordering is the whole mechanism, not cosmetics.
      expect(declaration).toBeGreaterThanOrEqual(0)
      expect(probe).toBeGreaterThan(declaration)
      expect(exec).toBeGreaterThan(probe)
    })

    it("RUNS, appending --trace-no-abis when the resolved nodeop advertises it", () => {
      const nodePath = Path.join(dir, "run-trace")
      expect(runScript("run-trace", {}, traceAwarePrefixPath)).toEqual([
        NodeopProcess.ConfigDirFlag,
        nodePath,
        NodeopProcess.DataDirFlag,
        Path.join(nodePath, ClusterConfigProvider.DataSubpath),
        NodeopProcess.TraceNoAbisFlag
      ])
    })

    it("RUNS, omitting --trace-no-abis when the resolved nodeop does NOT", () => {
      // The other half of the same probe: the default shim's `--help` prints
      // only its own argv, so the flag is absent and the argv is untouched.
      expect(runScript("run-no-trace")).not.toContain(
        NodeopProcess.TraceNoAbisFlag
      )
    })
  })

  it("emits the shared WIRE_PREFIX_PATH → PATH nodeop → WIRE_BUILD_PATH chain", () => {
    const script = render()
    StartScriptRenderer.prefixResolution().forEach(line =>
      expect(script).toContain(line)
    )
    expect(script).toContain(
      `command -v ${StartScriptRenderer.PrefixProbeBinary}`
    )
    expect(script).toContain("WIRE_BUILD_PATH")
  })

  it("execs nodeop under the resolved prefix", () => {
    expect(render()).toContain(
      `exec ${ApiNodeStartScriptRenderer.execTarget()}`
    )
    // The `bin/` segment comes from ClusterConfigProvider.BinSubpath — the same
    // constant `resolveExecutables` joins — never a second `"bin"` literal.
    expect(ApiNodeStartScriptRenderer.execTarget()).toBe(
      `"$${StartScriptVariable.WIRE_PREFIX_PATH}"'/${ClusterConfigProvider.BinSubpath}/${StartScriptRenderer.PrefixProbeBinary}'`
    )
    expect(ClusterConfigProvider.BinSubpath).toBe("bin")
  })

  it("RUNS, passing --config-dir + --data-dir rooted at the script's own directory", () => {
    const nodePath = Path.join(dir, "run-plain")
    expect(runScript("run-plain")).toEqual([
      "--config-dir",
      nodePath,
      "--data-dir",
      Path.join(nodePath, "data")
    ])
  })

  it("RUNS with --genesis-json only when a genesis was supplied", () => {
    const genesisJsonFile = Path.join(dir, "genesis.json")
    Fs.writeFileSync(genesisJsonFile, JSON.stringify({ initial_key: "x" }))
    const nodePath = Path.join(dir, "run-genesis")
    expect(runScript("run-genesis", { genesisJsonFile })).toEqual([
      "--config-dir",
      nodePath,
      "--data-dir",
      Path.join(nodePath, "data"),
      "--genesis-json",
      // The COPY beside the script, not the caller's source path.
      Path.join(nodePath, "genesis.json")
    ])
    expect(render({ genesisJsonFile })).toContain(NodeopProcess.GenesisJsonFlag)
    expect(render()).not.toContain(NodeopProcess.GenesisJsonFlag)
  })

  it("spells its argv flags with NodeopProcess's constants, not its own copies", () => {
    // NIT-7: one home for the nodeop flag spellings — the cluster argv builder
    // and this renderer must never drift onto two.
    expect(
      ApiNodeStartScriptRenderer.argvLines(
        ApiNodeConfig.resolve({
          outputPath: Path.join(dir, "out"),
          httpServerAddress: HttpServerAddress
        })
      )
    ).toEqual([
      `${NodeopProcess.ConfigDirFlag} "$${StartScriptVariable.NODE_DIR}"`,
      `${NodeopProcess.DataDirFlag} "$${StartScriptVariable.NODE_DIR}"'/${ClusterConfigProvider.DataSubpath}'`
    ])
  })

  it("fails loudly, naming WIRE_PREFIX_PATH, when the prefix cannot be resolved at all", () => {
    const nodePath = Path.join(dir, "run-noprefix")
    Fs.mkdirSync(nodePath, { recursive: true })
    const scriptFile = Path.join(nodePath, "start.sh")
    Fs.writeFileSync(scriptFile, render())
    // bash is invoked by ABSOLUTE path so the empty PATH below cannot make this
    // fail as an ENOENT on the interpreter — the only thing left to fail is the
    // script's own guard. The empty dir also removes the `command -v nodeop`
    // fallback, so all three resolution branches genuinely miss.
    const emptyPath = Path.join(dir, "empty-path")
    Fs.mkdirSync(emptyPath, { recursive: true })
    expect(() =>
      execFileSync(bashPath, [scriptFile], {
        encoding: "utf8",
        stdio: "pipe",
        env: { PATH: emptyPath }
      })
    ).toThrow()

    const failure = captureFailure(scriptFile, emptyPath)
    expect(failure).toContain(StartScriptVariable.WIRE_PREFIX_PATH)
    expect(failure).toContain("WIRE_BUILD_PATH")
  })

  it("ends with a trailing newline", () => {
    expect(render().endsWith("\n")).toBe(true)
  })
})
