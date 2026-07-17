import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { match } from "ts-pattern"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterFiles,
  ClusterStateNodeRole,
  ClusterStateVersion,
  type ClusterState as ClusterStateSnapshot,
  type ClusterStateNode
} from "@wireio/debugging-shared"
import { ClusterConfig } from "../config/ClusterConfig.js"
import { NodeConfig, NodeRole } from "../config/NodeConfig.js"
import type { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"
import { ClusterKeyStore } from "../orchestration/outputs/ClusterKeyStore.js"
import { OperatorDaemonArtifactsKey } from "../orchestration/outputs/OperatorDaemonArtifacts.js"
import type {
  EthereumKeyPair,
  SolanaKeyPair,
  WireFinalizerKeyPair,
  WireKeyPair
} from "../types/KeyPair.js"
import { AnvilProcess } from "./processes/AnvilProcess.js"
import { SolanaValidatorProcess } from "./processes/SolanaValidatorProcess.js"

/**
 * One producer node's on-disk key record in `cluster-keys.json` — the
 * persisted mirror of {@link ClusterKeyStore.NodeKeys}.
 */
export interface ClusterKeysNodeEntry {
  /** The producer node's topology index (matches `ClusterKeyStore.NodeKeys.index`). */
  index: number
  /** The node's WIRE block-signing (K1) key. */
  k1: WireKeyPair
  /** The node's finality (BLS) key. */
  bls: WireFinalizerKeyPair
}

/**
 * One provisioned operator's on-disk key record in `cluster-keys.json` — the
 * persisted mirror of {@link OperatorAccount}. Carries the operator's
 * `ethereum` / `solana` keys too (not just `wire`/`bls`) — the daemon
 * `--signature-provider` args (`OperatorDaemonTool.batchOperatorArgs` /
 * `underwriterArgs`) build directly from them on relaunch.
 */
export interface ClusterKeysOperatorEntry {
  account: string
  type: OperatorType
  wire: WireKeyPair
  bls?: WireFinalizerKeyPair
  ethereum?: EthereumKeyPair
  solana?: SolanaKeyPair
}

/**
 * The full `cluster-keys.json` payload — every producer node's key set plus
 * every provisioned operator account. `cluster-tool`-private: written 0600 by
 * {@link ClusterState.saveKeys}, read only by `ClusterManager.run` (via
 * {@link ClusterState.loadKeys} + {@link ClusterState.rehydrate}). Never
 * served over the debugging-server RPC surface.
 */
export interface ClusterKeys {
  /** Schema version — see {@link ClusterState.KeysVersion}. */
  version: number
  /** Every generated producer-node key set. */
  nodes: ClusterKeysNodeEntry[]
  /** Every provisioned operator account. */
  operators: ClusterKeysOperatorEntry[]
}

/** `NodeRole` (cluster-tool) → `ClusterStateNodeRole` (debugging-shared) —
 *  distinct nominal string enums with identical values; bridged by value via
 *  `match`, never a raw cast. */
function toClusterStateNodeRole(role: NodeRole): ClusterStateNodeRole {
  return match(role)
    .with(NodeRole.bios, () => ClusterStateNodeRole.bios)
    .with(NodeRole.producer, () => ClusterStateNodeRole.producer)
    .with(NodeRole.operator, () => ClusterStateNodeRole.operator)
    .exhaustive()
}

/**
 * The persistence bridge between a finished cluster build and
 * `wire-cluster-tool run`: capture the post-bootstrap topology + key material
 * from a {@link ClusterBuildContext}, persist it as `cluster-state.json`
 * (secret-free) + `cluster-keys.json` (0600), and reload/rehydrate it on a
 * later `run`. `cluster-state.json` is written by `create` for the debugging
 * surface (`PidSources` / the TUI cannot call `NodeConfig.plan`) — `run`
 * itself never reads it, since the topology is re-derived deterministically
 * from `NodeConfig.plan(config)`; {@link ClusterState.load} exists as
 * {@link ClusterState.save}'s round-trip-test counterpart and for tooling.
 */
export namespace ClusterState {
  /** Schema version for `cluster-keys.json` (independent of `ClusterStateVersion`). */
  export const KeysVersion = 1 as const
  /** File permission `cluster-keys.json` is written with (owner read/write only). */
  export const KeysFileMode = 0o600

  /** Absolute path of `cluster-state.json` for `config`. */
  export function stateFilePath(config: ClusterConfig): string {
    return Path.join(config.clusterPath, ClusterFiles.StateFilename)
  }

  /** Absolute path of `cluster-keys.json` for `config`. */
  export function keysFilePath(config: ClusterConfig): string {
    return Path.join(config.clusterPath, ClusterFiles.KeysFilename)
  }

  /**
   * Build the secret-free `cluster-state.json` snapshot from a finished
   * build's context: the planned topology (`NodeConfig.plan`), the wallet /
   * anvil-state / solana-ledger paths, and the prepared Solana IDL path (null
   * when no operator daemon artifacts were prepared — no Solana outpost).
   *
   * @param ctx - The build's context (config + outputs).
   * @returns The v2 cluster-state snapshot.
   */
  export function capture(ctx: ClusterBuildContext): ClusterStateSnapshot {
    const { config } = ctx
    const nodes: ClusterStateNode[] = NodeConfig.plan(config).map(node => ({
      name: node.name,
      role: toClusterStateNodeRole(node.role),
      nodePath: node.nodePath,
      ports: { http: node.ports.http, p2p: node.ports.p2p },
      producers: [...node.producers],
      batchOperatorAccount: node.batchOperatorAccount,
      underwriterAccount: node.underwriterAccount
    }))
    return {
      version: ClusterStateVersion,
      createdAt: new Date().toISOString(),
      nodes,
      walletPath: config.walletPath,
      anvilStateFile: Path.join(
        config.dataPath,
        AnvilProcess.StateSubpath,
        AnvilProcess.StateFilename
      ),
      solanaLedgerPath: Path.join(config.dataPath, SolanaValidatorProcess.LedgerSubpath),
      solanaIdlFile: ctx.outputs.get(OperatorDaemonArtifactsKey)?.solanaIdlFile ?? null
    }
  }

  /**
   * Build the `cluster-keys.json` payload from a finished build's
   * `ctx.keyStore` — every generated producer-node key set plus every
   * provisioned operator account (with its full key set, including
   * `ethereum` / `solana` when present).
   *
   * @param ctx - The build's context (holds `keyStore`).
   * @returns The key-material payload.
   */
  export function captureKeys(ctx: ClusterBuildContext): ClusterKeys {
    return {
      version: KeysVersion,
      nodes: ctx.keyStore.nodes.map(nodeKeys => ({
        index: nodeKeys.index,
        k1: nodeKeys.keys.k1,
        bls: nodeKeys.keys.bls
      })),
      operators: ctx.keyStore.operators.map(operator => ({ ...operator }))
    }
  }

  /** Write `state` to {@link stateFilePath}. */
  export function save(config: ClusterConfig, state: ClusterStateSnapshot): void {
    Fs.writeFileSync(stateFilePath(config), JSON.stringify(state, null, 2))
  }

  /** Write `keys` to {@link keysFilePath}, then enforce {@link KeysFileMode} — `writeFileSync`'s
   *  `mode` option is honored only on file CREATION, so a re-write over an
   *  existing file needs the explicit `chmodSync` to guarantee 0600. */
  export function saveKeys(config: ClusterConfig, keys: ClusterKeys): void {
    const file = keysFilePath(config)
    Fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: KeysFileMode })
    Fs.chmodSync(file, KeysFileMode)
  }

  /**
   * Read + version-check `cluster-state.json`.
   *
   * @throws If the file is missing, or its `version` doesn't match {@link ClusterStateVersion}.
   */
  export function load(config: ClusterConfig): ClusterStateSnapshot {
    const file = stateFilePath(config)
    Assert.ok(
      Fs.existsSync(file),
      `ClusterState.load: ${file} not found — run "wire-cluster-tool create" first`
    )
    const parsed = JSON.parse(Fs.readFileSync(file, "utf8")) as ClusterStateSnapshot
    Assert.ok(
      parsed.version === ClusterStateVersion,
      `ClusterState.load: ${file} is version ${parsed.version}, expected ${ClusterStateVersion} — re-run "wire-cluster-tool create"`
    )
    return parsed
  }

  /**
   * Read + version-check `cluster-keys.json`.
   *
   * @throws If the file is missing, or its `version` doesn't match {@link KeysVersion}.
   */
  export function loadKeys(config: ClusterConfig): ClusterKeys {
    const file = keysFilePath(config)
    Assert.ok(
      Fs.existsSync(file),
      `ClusterState.loadKeys: ${file} not found — run "wire-cluster-tool create" first`
    )
    const parsed = JSON.parse(Fs.readFileSync(file, "utf8")) as ClusterKeys
    Assert.ok(
      parsed.version === KeysVersion,
      `ClusterState.loadKeys: ${file} is version ${parsed.version}, expected ${KeysVersion} — re-run "wire-cluster-tool create"`
    )
    return parsed
  }

  /**
   * Repopulate a fresh {@link ClusterKeyStore} from a loaded {@link ClusterKeys}
   * payload — every node key set + every operator account, so relaunch-time
   * operator/daemon-arg resolution (`NodeopProcessSteps.resolveOperator` /
   * `resolveOperatorDaemonArgs`) works unchanged against the rehydrated store.
   *
   * @param keyStore - The (empty) store to populate.
   * @param keys - The loaded key payload.
   */
  export function rehydrate(keyStore: ClusterKeyStore, keys: ClusterKeys): void {
    keyStore.pushNodes(
      ...keys.nodes.map(entry => ({
        index: entry.index,
        keys: { k1: entry.k1, bls: entry.bls }
      }))
    )
    keys.operators.forEach(entry => keyStore.setOperator(entry))
  }
}
