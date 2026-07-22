import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import {
  ClusterConfigLoggingFileFormat,
  ClusterFiles,
  ClusterStateNodeRole,
  type ClusterConfig,
  type ClusterState,
  type ClusterStateNode
} from "@wireio/cluster-tool-shared"
import { Level } from "@wireio/shared"
import { PidSources, oppDebuggingPath } from "@wireio/debugging-shared"

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
  const clusterPath = Fs.mkdtempSync(
      Path.join(OS.tmpdir(), "fixture-cluster-")
    ),
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
    name: string,
    nodePath: string,
    role: ClusterStateNodeRole,
    batchOperatorLabel: string | null = null,
    underwriterLabel: string | null = null
  ): ClusterStateNode => ({
    name,
    role,
    nodePath,
    ports: { http: 0, p2p: 0 },
    producers: [],
    batchOperatorLabel,
    underwriterLabel
  })

  const state: ClusterState = {
    createdAt: new Date().toISOString(),
    nodes: [
      node(PidSources.BiosNodeId, biosDir, ClusterStateNodeRole.bios),
      node("node_00", batchDir, ClusterStateNodeRole.operator, "batchop1"),
      node(
        "node_01",
        underwriterDir,
        ClusterStateNodeRole.operator,
        null,
        "underwriter1"
      )
    ],
    walletPath: "",
    anvilStateFile: "",
    solanaLedgerPath: "",
    solanaIdlFile: null
  }

  const config: ClusterConfig = {
    buildPath: "",
    clusterPath,
    dataPath,
    walletPath: "",
    producerCount: 1,
    nodeCount: 3,
    batchOperatorCount: 1,
    underwriterCount: 1,
    epochDurationSec: 60,
    warmupEpochs: 0,
    cooldownEpochs: 0,
    ethereumPath: "",
    solanaPath: "",
    bind: {
      kiod: { address: "127.0.0.1", port: 0 },
      nodeop: {
        address: "127.0.0.1",
        ports: {
          bios: { http: 0, p2p: 0 },
          producers: [],
          batch: [],
          underwriters: []
        }
      },
      anvil: { address: "127.0.0.1", port: 0 },
      solana: {
        address: "127.0.0.1",
        ports: {
          http: 0,
          faucet: 0,
          gossip: 0,
          dynamicRange: { first: 0, last: 0 }
        }
      },
      debuggingServer: { address: "127.0.0.1", port: 0 }
    },
    executables: {
      nodeop: "",
      kiod: "",
      clio: "",
      anvil: "",
      solanaTestValidator: ""
    },
    report: {
      path: "",
      basename: "cluster-build",
      formats: []
    },
    logging: {
      levels: { console: Level.info, file: Level.debug },
      fileFormat: ClusterConfigLoggingFileFormat.jsonl
    },
    requiredBatchOperatorCollateral: [],
    requiredUnderwriterCollateral: [],
    requiredProducerCollateral: [],
    underwriterCollateral: null,
    initialFinalizerKey: null
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
