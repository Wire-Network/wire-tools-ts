/**
 * Role a cluster node plays. Identity-mapped string enum matching
 * `cluster-tool`'s `NodeRole` (`bios` / `producer` / `operator`) — the
 * identical string values mean a `cluster-tool` `NodeRole` member satisfies
 * this type with no cast.
 */
export enum ClusterStateNodeRole {
  bios = "bios",
  producer = "producer",
  operator = "operator"
}

/** One `nodeop` instance's `{ http, p2p }` listen ports. */
export interface ClusterStateNodePorts {
  /** HTTP (RPC) listen port. */
  http: number
  /** P2P listen port. */
  p2p: number
}

/**
 * Post-bootstrap snapshot of a single cluster node, planned deterministically
 * by `cluster-tool`'s `NodeConfig.plan` and persisted read-only for tooling
 * and for `wire-cluster-tool run`'s relaunch path. Carries no key material —
 * see `cluster-keys.json` (`ClusterFiles.KeysFilename`) for that.
 */
export interface ClusterStateNode {
  /** Canonical node name (`bios`, `node_00`, …). */
  name: string
  /** Role this node plays. */
  role: ClusterStateNodeRole
  /** Absolute on-disk directory for this node's data + logs. */
  nodePath: string
  /** This node's `{ http, p2p }` listen ports. */
  ports: ClusterStateNodePorts
  /** Producer account names scheduled on this node (empty for pure operator nodes). */
  producers: string[]
  /** Batch-operator provisioning label this node acts for, when `role === operator`. */
  batchOperatorLabel: string | null
  /** Underwriter provisioning label this node acts for, when `role === operator`. */
  underwriterLabel: string | null
}

/**
 * Post-bootstrap snapshot of cluster runtime layout. Written once by
 * `wire-cluster-tool create` (via `ClusterManager.create`'s persist phase)
 * and reloaded — read-only — by `run`, the debugging server, the TUI, and
 * `PidSources`. Secret-free by design: signing key material lives in the
 * separate `cluster-keys.json`, never here.
 */
export interface ClusterState {
  /** ISO-8601 timestamp of when this snapshot was written. */
  createdAt: string
  /** Every node in the cluster — bios, producers, and operator nodes alike. */
  nodes: ClusterStateNode[]
  /** Absolute path of the cluster's `kiod` wallet directory. */
  walletPath: string
  /** Absolute path of anvil's `--dump-state` / `--load-state` file. */
  anvilStateFile: string
  /** Absolute path of the solana-test-validator ledger directory. */
  solanaLedgerPath: string
  /** Absolute path of the primary IDL shared with batch operators, or `null` when no Solana outpost is configured. */
  solanaIdlFile: string | null
}
