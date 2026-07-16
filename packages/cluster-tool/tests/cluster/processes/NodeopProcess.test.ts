import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { NodeopProcess, ProcessManager } from "@wireio/cluster-tool/cluster/processes"
import { NodeConfig, NodeRole, type ClusterConfig } from "@wireio/cluster-tool/config"
import { type OperatorAccount } from "@wireio/cluster-tool/orchestration/outputs"
import { Localhost } from "@wireio/cluster-tool/utils"
import { fixtureConfig, PersistedFixture } from "../../config/clusterConfigFixture.js"

describe("NodeopProcess", () => {
  let dir: string
  let manager: ProcessManager
  let cluster: ClusterConfig
  beforeAll(() => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "nodeop-"))
    Fs.writeFileSync(
      Path.join(dir, "genesis.json"),
      JSON.stringify({ initial_timestamp: "2026-01-01T00:00:00.000" })
    )
    ProcessManager.setClusterPath(dir)
    manager = ProcessManager.get()
    // Fixture ClusterConfig aimed at this test's sandbox — NodeopProcess
    // derives node dirs + `genesisFile` from `clusterPath`/`dataPath`, and
    // the fixture's node counts (1/3/1) match the planning assertions below.
    cluster = fixtureConfig({
      clusterPath: dir,
      dataPath: Path.join(dir, "data"),
      executables: { ...PersistedFixture.executables, nodeop: "/bin/true" },
      bind: {
        ...PersistedFixture.bind,
        nodeop: { ...PersistedFixture.bind.nodeop, address: "0.0.0.0" }
      }
    })
  })
  afterEach(async () => {
    await manager.stopAll()
  })
  afterAll(() => {
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  /** A planned node over the structural cluster config. */
  function node(
    name: string,
    role: NodeRole,
    producers: string[] = [],
    peers: string[] = []
  ): NodeConfig {
    return new NodeConfig(cluster, role, 0, name, { http: 8888, p2p: 9876 }, producers, peers)
  }

  /** A producer OperatorAccount carrying the node-shared signing keys. */
  function producerOperator(account: string): OperatorAccount {
    return {
      account,
      type: OperatorType.PRODUCER,
      wire: { type: KeyType.K1, publicKey: "PUB_K1_p", privateKey: "PVT_K1_s" },
      bls: {
        type: KeyType.BLS,
        publicKey: "PUB_BLS_p",
        privateKey: "PVT_BLS_s",
        proofOfPossession: "SIG_BLS_x"
      }
    }
  }

  it("requires genesis.json to exist", async () => {
    // `genesisFile` derives from `clusterPath` — a cluster path with no
    // genesis.json written under it is the missing-genesis case.
    const missing = fixtureConfig({
      clusterPath: "/nope",
      dataPath: Path.join(dir, "data"),
      executables: { ...PersistedFixture.executables, nodeop: "/bin/true" },
      bind: {
        ...PersistedFixture.bind,
        nodeop: { ...PersistedFixture.bind.nodeop, address: "0.0.0.0" }
      }
    })
    await expect(
      NodeopProcess.create(manager, {
        node: new NodeConfig(missing, NodeRole.producer, 0, "missing-genesis", { http: 1, p2p: 2 }, [], [])
      })
    ).rejects.toThrow(/genesis/)
  })

  it("requires a producer OperatorAccount (wire + bls) for a producing node", async () => {
    await expect(
      NodeopProcess.create(manager, { node: node("keyless", NodeRole.producer, ["sysio"]) })
    ).rejects.toThrow(/requires a producer OperatorAccount/)
  })

  it("builds a producer node's argv from the composed node + operator", async () => {
    const nodeop = await NodeopProcess.create(manager, {
      node: node("producer", NodeRole.producer, ["sysio"], ["127.0.0.1:9877"]),
      operator: producerOperator("sysio")
    })
    expect(nodeop.exe).toBe("/bin/true")
    expect(nodeop.args).toEqual(
      expect.arrayContaining([
        "--plugin",
        "sysio::producer_plugin",
        "--producer-name",
        "sysio",
        "--p2p-peer-address",
        "127.0.0.1:9877",
        "--genesis-json",
        "--genesis-timestamp",
        "2026-01-01T00:00:00.000"
      ])
    )
    // endpoints derive from the cluster bind address + the node's ports
    expect(nodeop.args).toEqual(
      expect.arrayContaining(["--p2p-listen-endpoint", "0.0.0.0:9876"])
    )
    expect(nodeop.args.filter(arg => arg === "--signature-provider")).toHaveLength(2)
    expect(nodeop.args.some(arg => arg.includes("wire-PUB_K1_p"))).toBe(true)
    expect(nodeop.args.some(arg => arg.includes("wire-bls-PUB_BLS_p"))).toBe(true)
    expect(nodeop.httpUrl).toContain(Localhost)
  })

  it("omits the producer block for a non-producing node + appends extraArgs", async () => {
    const nodeop = await NodeopProcess.create(manager, {
      node: node("operator-daemon", NodeRole.operator),
      operator: producerOperator("batchopaaaa"),
      extraArgs: ["--batch-enabled", "true"]
    })
    expect(nodeop.args).not.toContain("sysio::producer_plugin")
    expect(nodeop.args).not.toContain("--producer-name")
    expect(nodeop.args).toEqual(
      expect.arrayContaining(["--plugin", "sysio::net_plugin", "--batch-enabled", "true"])
    )
  })

  it("applies tuning overrides over the defaults", async () => {
    const nodeop = await NodeopProcess.create(manager, {
      node: node("tuned", NodeRole.operator),
      tuning: { maxClients: 99 }
    })
    expect(nodeop.args).toEqual(expect.arrayContaining(["--max-clients", "99"]))
    expect(nodeop.args).toEqual(
      expect.arrayContaining([
        "--vote-threads",
        String(NodeopProcess.DefaultVoteThreads)
      ])
    )
  })

  it("derives the loopback peer allowance from the cluster topology", async () => {
    const nodeop = await NodeopProcess.create(manager, {
      node: node("peered", NodeRole.operator)
    })
    // 1 producer node + 3 batch ops + 1 underwriter + bios + ad-hoc headroom
    const allowance =
      1 + 3 + 1 + NodeopProcess.BiosNodeCount + NodeopProcess.AdHocDaemonPeerHeadroom
    expect(nodeop.args).toEqual(
      expect.arrayContaining(["--p2p-max-nodes-per-host", String(allowance)])
    )
  })

  it("buildRelaunchArgs strips genesis flags + adds enable-stale-production", () => {
    const relaunch = NodeopProcess.buildRelaunchArgs([
      "--genesis-json",
      "/g.json",
      "--genesis-timestamp",
      "2026",
      "--data-dir",
      "/d"
    ])
    expect(relaunch).not.toContain("--genesis-json")
    expect(relaunch).not.toContain("--genesis-timestamp")
    expect(relaunch).not.toContain("/g.json")
    expect(relaunch).toEqual(expect.arrayContaining(["--data-dir", "/d"]))
    expect(relaunch).toContain("--enable-stale-production")
  })

  it("relaunch mode strips the one-shot genesis flags from the instance argv", async () => {
    const nodeop = await NodeopProcess.create(manager, {
      node: node("relaunched", NodeRole.operator),
      relaunch: true
    })
    expect(nodeop.args).not.toContain("--genesis-json")
    expect(nodeop.args).not.toContain("--genesis-timestamp")
    // everything else survives the strip
    expect(nodeop.args).toEqual(
      expect.arrayContaining(["--plugin", "sysio::net_plugin"])
    )
  })

  describe("dirty-chainbase recovery", () => {
    /** chainbase's real abort line (`pinnable_mapped_file.cpp`). */
    const DirtyLine = '"state" database dirty flag set'

    it("DirtyChainbasePattern matches chainbase's abort line only", () => {
      expect(NodeopProcess.DirtyChainbasePattern.test(DirtyLine)).toBe(true)
      expect(
        NodeopProcess.DirtyChainbasePattern.test("Produced block 00abc... #42")
      ).toBe(false)
    })

    it("isDirtyChainbaseAbort requires an EXITED child carrying the abort line", () => {
      expect(
        NodeopProcess.isDirtyChainbaseAbort({ isRunning: false, recentOutput: [DirtyLine] })
      ).toBe(true)
      expect(
        NodeopProcess.isDirtyChainbaseAbort({ isRunning: true, recentOutput: [DirtyLine] })
      ).toBe(false)
      expect(
        NodeopProcess.isDirtyChainbaseAbort({ isRunning: false, recentOutput: ["clean exit"] })
      ).toBe(false)
      expect(
        NodeopProcess.isDirtyChainbaseAbort({ isRunning: false, recentOutput: [] })
      ).toBe(false)
    })

    it("finalizerSafetyFile is <data-dir>/finalizers/safety.dat", () => {
      expect(NodeopProcess.finalizerSafetyFile({ nodePath: "/data/node_00" })).toBe(
        "/data/node_00/finalizers/safety.dat"
      )
    })

    /** Fixture aimed at a nodeop stand-in: WITHOUT --hard-replay-blockchain it
     *  aborts exactly like a dirty chainbase; WITH it, it stays up. */
    let dirtyCluster: ClusterConfig
    let readySpy: jest.SpyInstance
    beforeAll(() => {
      const fakeNodeop = Path.join(dir, "fake-dirty-nodeop")
      Fs.writeFileSync(
        fakeNodeop,
        [
          "#!/bin/bash",
          'for arg in "$@"; do',
          '  if [[ "$arg" == "--hard-replay-blockchain" ]]; then exec /bin/sleep 300; fi',
          "done",
          `echo '${DirtyLine}' >&2`,
          "exit 2"
        ].join("\n"),
        { mode: 0o755 }
      )
      dirtyCluster = fixtureConfig({
        clusterPath: dir,
        dataPath: Path.join(dir, "data"),
        executables: { ...PersistedFixture.executables, nodeop: fakeNodeop },
        bind: {
          ...PersistedFixture.bind,
          nodeop: { ...PersistedFixture.bind.nodeop, address: "0.0.0.0" }
        }
      })
      // Deterministic readiness with no HTTP server: only the hard-replay
      // relaunch (which stays up) counts as ready. The dirty first boot dies
      // instantly and fails via the dead-child fast path regardless of any
      // verify race.
      interface VerifyReadyProbe {
        verifyReady(): Promise<boolean>
      }
      const proto = NodeopProcess.prototype as unknown as VerifyReadyProbe
      readySpy = jest
        .spyOn(proto, "verifyReady")
        .mockImplementation(function (this: NodeopProcess) {
          return Promise.resolve(
            this.isRunning && this.args.includes(NodeopProcess.HardReplayBlockchainFlag)
          )
        })
    })
    afterAll(() => {
      readySpy.mockRestore()
    })

    /** A planned operator node over the dirty-cluster fixture. */
    function dirtyNode(name: string): NodeConfig {
      return new NodeConfig(dirtyCluster, NodeRole.operator, 0, name, { http: 18888, p2p: 19876 }, [], [])
    }

    it("startWithRecovery relaunches once with --hard-replay-blockchain and wipes the stale fsi", async () => {
      const node = dirtyNode("dirty-recovers")
      const safetyFile = NodeopProcess.finalizerSafetyFile(node)
      Fs.mkdirSync(Path.dirname(safetyFile), { recursive: true })
      Fs.writeFileSync(safetyFile, "stale-fsi")

      const recovered = await NodeopProcess.startWithRecovery(manager, { node })
      expect(recovered.args).toContain(NodeopProcess.HardReplayBlockchainFlag)
      // The retry runs in relaunch mode — one-shot genesis flags are stale.
      expect(recovered.args).not.toContain("--genesis-json")
      expect(recovered.isRunning).toBe(true)
      expect(manager.get("dirty-recovers")).toBe(recovered)
      // The fsi lock points into the reversible blocks hard replay discards —
      // leaving it would stall finality (fsi lockout), so recovery removes it.
      expect(Fs.existsSync(safetyFile)).toBe(false)
      await recovered.kill()
    })

    it("startWithRecovery rethrows a non-dirty failure without retrying or touching the fsi", async () => {
      // The outer fixture's nodeop is /bin/true: it exits cleanly with no
      // output — a startup failure that is NOT the dirty-chainbase abort.
      const cleanNode = node("clean-dies", NodeRole.operator)
      const safetyFile = NodeopProcess.finalizerSafetyFile(cleanNode)
      Fs.mkdirSync(Path.dirname(safetyFile), { recursive: true })
      Fs.writeFileSync(safetyFile, "keep-me")

      await expect(
        NodeopProcess.startWithRecovery(manager, { node: cleanNode })
      ).rejects.toThrow(/before passing verifyReady/)
      expect(Fs.existsSync(safetyFile)).toBe(true)
      // No retry: the first (failed) instance still owns the label.
      expect(manager.get("clean-dies")).not.toBeNull()
    })

    it("start() surfaces the dirty abort line in the rejection via startupFailureDetail", async () => {
      const first = await NodeopProcess.create(manager, { node: dirtyNode("dirty-detail") })
      await expect(first.start()).rejects.toThrow(/database dirty flag set/)
    })
  })
})
