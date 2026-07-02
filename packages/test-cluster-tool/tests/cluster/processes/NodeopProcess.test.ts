import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { NodeopProcess, ProcessManager } from "@wireio/test-cluster-tool/cluster/processes"
import { NodeConfig, NodeRole, type ClusterConfig } from "@wireio/test-cluster-tool/config"
import { type OperatorAccount } from "@wireio/test-cluster-tool/orchestration/outputs"
import { Localhost } from "@wireio/test-cluster-tool/utils"

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
    // Structural ClusterConfig covering exactly what NodeopProcess derives from
    // (binaries, bind address, node dirs, the genesis file).
    cluster = {
      clusterPath: dir,
      dataPath: Path.join(dir, "data"),
      executables: { nodeop: "/bin/true" },
      bind: { nodeop: { address: "0.0.0.0" } },
      genesisFile: Path.join(dir, "genesis.json"),
      nodeCount: 1,
      batchOperatorCount: 3,
      underwriterCount: 1
    } as unknown as ClusterConfig
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
    const missing = {
      ...cluster,
      genesisFile: "/nope/genesis.json"
    } as unknown as ClusterConfig
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
})
