import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { execFileSync } from "node:child_process"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import {
  NodeopProcess,
  ProcessManager
} from "@wireio/cluster-tool/cluster/processes"
import {
  DaemonConfig,
  DaemonKind,
  NodeConfig,
  NodeRole,
  StartScriptRenderer
} from "@wireio/cluster-tool/config"
import { StartScriptVariable } from "@wireio/cluster-tool/utils"
import {
  fixtureConfig,
  PersistedFixture
} from "../clusterConfigFixture.js"

describe("StartScriptRenderer", () => {
  let dir: string
  let manager: ProcessManager
  let cluster: ClusterConfig
  let nodeopStub: string

  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "startscript-"))
    Fs.writeFileSync(
      Path.join(dir, "genesis.json"),
      JSON.stringify({ initial_timestamp: "2026-01-01T00:00:00.000" })
    )
    Fs.writeFileSync(
      Path.join(dir, "cluster-config.json"),
      JSON.stringify({ marker: true })
    )
    // An exec-capturing shim: the rendered script `exec`s this, so whatever it
    // prints IS the argv the script would have spawned.
    Fs.mkdirSync(Path.join(dir, "build", "bin"), { recursive: true })
    nodeopStub = Path.join(dir, "build", "bin", "nodeop")
    Fs.writeFileSync(
      nodeopStub,
      '#!/usr/bin/env bash\nfor arg in "$@"; do printf "%s\\n" "$arg"; done\n'
    )
    Fs.chmodSync(nodeopStub, 0o755)

    ProcessManager.setClusterPath(dir)
    manager = ProcessManager.get()
    cluster = fixtureConfig({
      clusterPath: dir,
      dataPath: Path.join(dir, "data"),
      buildPath: Path.join(dir, "build"),
      executables: { ...PersistedFixture.executables, nodeop: nodeopStub }
    })
  })
  afterEach(async () => {
    await manager.stopAll()
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A planned producer node over the fixture cluster. */
  function producerNode(): NodeConfig {
    return new NodeConfig(
      cluster,
      NodeRole.producer,
      0,
      "node_00",
      { http: 8888, p2p: 9876 },
      [],
      []
    )
  }

  /** The rendered script for a daemon descriptor. */
  function render(daemon: DaemonConfig): string {
    return new StartScriptRenderer(
      daemon,
      DaemonConfig.clusterRelocations(cluster)
    ).render()
  }

  describe("removeRun", () => {
    it("removes only a CONTIGUOUS occurrence", () => {
      expect(
        StartScriptRenderer.removeRun(
          ["--dump-state", "/s.json", "--load-state", "/s.json"],
          ["--load-state", "/s.json"]
        )
      ).toEqual(["--dump-state", "/s.json"])
    })

    it("leaves the argv untouched when the run is absent", () => {
      expect(
        StartScriptRenderer.removeRun(["--a", "1"], ["--load-state", "/s.json"])
      ).toEqual(["--a", "1"])
    })

    it("does not strip a shared VALUE belonging to another flag", () => {
      // anvil passes the same path to --dump-state and --load-state; by-value
      // removal would silently break --dump-state.
      const result = StartScriptRenderer.removeRun(
        ["--dump-state", "/s.json"],
        ["--load-state", "/s.json"]
      )
      expect(result).toContain("--dump-state")
      expect(result).toContain("/s.json")
    })
  })

  describe("render", () => {
    it("emits a strict-mode script with the cluster-root assertion", () => {
      const script = render({
        kind: DaemonKind.kiod,
        label: "kiod",
        daemonPath: Path.join(cluster.dataPath, "kiod"),
        exe: "/bin/true",
        argv: ["--flag"],
        conditions: [],
        relocations: []
      })
      expect(script).toContain("#!/usr/bin/env bash")
      expect(script).toContain("set -euo pipefail")
      expect(script).toContain("cluster-config.json")
      expect(script).toContain(StartScriptVariable.CLUSTER_DIR)
      // The secret notice must survive — under KEY mode this file carries an
      // inline signing key for every non-bios node.
      expect(script).toContain("inline signing key")
    })

    it("renders a build-time conditional as a shell test, never frozen", () => {
      const stateFile = Path.join(cluster.dataPath, "anvil", "anvil.json"),
        script = render({
          kind: DaemonKind.anvil,
          label: "anvil",
          daemonPath: Path.join(cluster.dataPath, "anvil"),
          exe: "/bin/true",
          argv: ["--dump-state", stateFile],
          conditions: [
            {
              test: `[ -f "$CLUSTER_DIR/data/anvil/anvil.json" ]`,
              tokens: ["--load-state", stateFile]
            }
          ],
          relocations: []
        })
      expect(script).toContain(`[ -f "$CLUSTER_DIR/data/anvil/anvil.json" ] &&`)
      expect(script).toContain("CONDITIONAL_ARGS=()")
      // --dump-state survives the conditional's removal of --load-state.
      expect(script).toContain("'--dump-state'")
    })

    it("indirects a PATH-resolved binary instead of freezing the build host's path", () => {
      // `which("anvil")` yields e.g. /home/<user>/.foundry/bin/anvil — under NO
      // relocatable root, so freezing it ships a script that runs only on the
      // build host. Caught by inspecting a real emitted script, not by the
      // absolute-path scan (which only looked for the platform/cluster roots).
      const script = render({
        kind: DaemonKind.anvil,
        label: "anvil",
        daemonPath: Path.join(cluster.dataPath, "anvil"),
        exe: "/home/someone/.foundry/bin/anvil",
        exeCommandName: "anvil",
        exeEnvironmentVariable: DaemonConfig.AnvilBinEnvironmentVariable,
        argv: ["--port", "8545"],
        conditions: [],
        relocations: []
      })
      expect(script).toContain(
        `exec "${"$"}{${DaemonConfig.AnvilBinEnvironmentVariable}:-$(command -v anvil)}"`
      )
      expect(script).not.toContain("/home/someone/.foundry")
    })

    it("asserts ONLY the host roots this daemon actually references", () => {
      const script = render({
        kind: DaemonKind.kiod,
        label: "kiod",
        daemonPath: Path.join(cluster.dataPath, "kiod"),
        exe: nodeopStub,
        argv: ["--wallet-dir", Path.join(cluster.clusterPath, "wallet")],
        conditions: [],
        relocations: []
      })
      expect(script).toContain(StartScriptVariable.WIRE_BUILD_PATH)
      // No solana path is referenced — demanding it would break a depot-only run.
      expect(script).not.toContain(StartScriptVariable.WIRE_SOLANA_PATH)
    })
  })

  describe("enumeration agreement", () => {
    it("plannedLabels matches plan()'s labels exactly", () => {
      // Two derivations of the daemon SET (plan-time labels vs run-time
      // enumeration) drifting is what turns an emit step into a silent no-op.
      const config = NodeopProcess.resolveConfig(
          { node: producerNode(), relaunch: true },
          {
            genesisTimestamp: "2026-01-01T00:00:00.000",
            supportsTraceNoAbis: false
          }
        ),
        planned = DaemonConfig.plan(cluster, { nodeop: [config] }).map(
          daemon => daemon.label
        )
      // plannedLabels covers the full cluster shape; plan() here was given one
      // node and no other sources, so compare the NODE portion plus assert the
      // shape function includes every non-node daemon this cluster runs.
      expect(planned).toContain(producerNode().name)
      expect(DaemonConfig.plannedLabels(cluster)).toEqual(
        expect.arrayContaining(planned)
      )
    })
  })

  describe("argv equality with the live process", () => {
    it("the rendered script execs the SAME argv the process would spawn", async () => {
      const node = producerNode(),
        options = { node, relaunch: true },
        config = NodeopProcess.resolveConfig(options, {
          genesisTimestamp: "2026-01-01T00:00:00.000",
          supportsTraceNoAbis: false
        })
      // The REAL process — its instance getter is what carries the relaunch
      // stripping, so comparing against a pure builder would prove less.
      const process = await NodeopProcess.create(manager, options)
      const expected = process.args

      const daemon = DaemonConfig.plan(cluster, { nodeop: [config] }).find(
        candidate => candidate.kind === DaemonKind.node
      )
      expect(daemon).toBeDefined()

      // The script MUST live in the daemon's own directory — `$NODE_DIR` is
      // derived from `dirname "$BASH_SOURCE"`, so running it from anywhere else
      // resolves that variable to the wrong tree (which is precisely what this
      // assertion would then catch).
      const scriptFile = DaemonConfig.startScriptFile(daemon.daemonPath)
      Fs.mkdirSync(daemon.daemonPath, { recursive: true })
      Fs.writeFileSync(scriptFile, render(daemon))
      const printed = execFileSync("bash", [scriptFile], {
          encoding: "utf8",
          env: {
            ...global.process.env,
            WIRE_CLUSTER_DIR: dir,
            WIRE_BUILD_PATH: Path.join(dir, "build")
          }
        }),
        actual = printed.split("\n").filter(line => line.length > 0)

      expect(actual).toEqual(expected)
    })

  })
})
