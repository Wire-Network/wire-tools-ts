import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  ClusterFiles,
  NodeRole,
  PidSources,
  oppDebuggingPath,
  type ClusterConfig,
  type ClusterState,
  type NodeState
} from "@wireio/debugging-shared"

/** Disposable on-disk cluster fixture. */
export interface FixtureCluster {
  clusterPath: string
  cleanup(): void
  writePid(relDir: string, label: string, pid: number): string
  writeLog(relDir: string, filename: string, content: string): string
  appendLog(relDir: string, filename: string, content: string): void
  state: ClusterState
}

/**
 * Materialize a minimal cluster directory in a tmp dir. One bios producer,
 * one batch operator, one underwriter — pid files written under each
 * node's `dataPath`. State is also persisted to `cluster-state.json` so
 * `getClusterState()` finds it.
 */
export function makeFixtureCluster(): FixtureCluster {
  const clusterPath = Fs.mkdtempSync(Path.join(OS.tmpdir(), "fixture-cluster-")),
    dataPath = Path.join(clusterPath, "data"),
    biosDir = Path.join(dataPath, "node_bios"),
    batchDir = Path.join(dataPath, "node_b1"),
    underwriterDir = Path.join(dataPath, "node_u1")

  ;[biosDir, batchDir, underwriterDir].forEach(d =>
    Fs.mkdirSync(Path.join(d, PidSources.LogsSubdir), { recursive: true })
  )
  // Pre-create the OPP debugging dir so the watcher can attach.
  Fs.mkdirSync(oppDebuggingPath(clusterPath), { recursive: true })

  const node = (
    nodeId: string | number,
    nodeDir: string,
    role: NodeRole
  ): NodeState => ({
    nodeId,
    host: "127.0.0.1",
    port: 0,
    dataPath: nodeDir,
    configPath: "",
    cmd: [],
    isProducer: role === NodeRole.Producer,
    producerName: null,
    role
  })

  const state: ClusterState = {
    pnodes: 1,
    totalNodes: 3,
    prodCount: 1,
    topo: "mesh",
    nodes: [node(PidSources.BiosNodeId, biosDir, NodeRole.Producer)],
    batchOperatorNodes: [node(1, batchDir, NodeRole.BatchOperator)],
    underwriterNodes: [node(1, underwriterDir, NodeRole.Underwriter)],
    anvilStatePath: "",
    solanaLedgerPath: "",
    walletPath: ""
  }

  const config: ClusterConfig = {
    buildPath: "",
    clusterPath,
    walletPath: "",
    dataPath,
    producerCount: 1,
    nodeCount: 3,
    httpSecure: false,
    batchOperatorCount: 1,
    underwriterCount: 1,
    ethereumPath: "",
    solanaPath: "",
    epochDurationSec: 60,
    warmupEpochs: 0,
    cooldownEpochs: 0,
    ports: {
      kiod: 0,
      biosHttp: 0,
      biosP2p: 0,
      producerHttp: [],
      producerP2p: [],
      batchOperatorHttp: [],
      batchOperatorP2p: [],
      underwriterHttp: [],
      underwriterP2p: [],
      anvil: 0,
      solanaRpc: 0,
      solanaFaucet: 0,
      debuggingServer: 0
    },
    executables: {
      nodeop: "",
      kiod: "",
      clio: "",
      sysUtil: "",
      anvil: "",
      solanaTestValidator: ""
    }
  }

  Fs.writeFileSync(
    Path.join(clusterPath, ClusterFiles.ConfigFilename),
    JSON.stringify(config, null, 2)
  )
  Fs.writeFileSync(
    Path.join(clusterPath, ClusterFiles.StateFilename),
    JSON.stringify(state, null, 2)
  )

  return {
    clusterPath,
    state,
    cleanup() {
      Fs.rmSync(clusterPath, { recursive: true, force: true })
    },
    writePid(relDir, label, pid) {
      const dir = Path.join(clusterPath, relDir)
      Fs.mkdirSync(dir, { recursive: true })
      const file = Path.join(dir, `${label}${PidSources.PidExt}`)
      Fs.writeFileSync(file, `${pid}\n`)
      return file
    },
    writeLog(relDir, filename, content) {
      const dir = Path.join(clusterPath, relDir)
      Fs.mkdirSync(dir, { recursive: true })
      const file = Path.join(dir, filename)
      Fs.writeFileSync(file, content)
      return file
    },
    appendLog(relDir, filename, content) {
      const file = Path.join(clusterPath, relDir, filename)
      Fs.appendFileSync(file, content)
    }
  }
}
