/**
 * Shared cluster type definitions.
 *
 * These shapes describe the on-disk JSON files produced by the `harness`
 * `ClusterManager` (`cluster-config.json` + `cluster-state.json`). They
 * live in `debugging-shared` so that external tooling — the debugging
 * server, the TUI client, and any third-party inspector — can consume
 * them without pulling in the full harness runtime.
 *
 * `PersistedClusterConfig` (the `cluster-config.json` shape) is
 * single-sourced here rather than in `cluster-tool` so the harness and
 * every debugging consumer read/write the identical type. Its nested
 * shapes (`PersistedClusterConfigBind*` / `PersistedClusterConfigReport` /
 * `PersistedClusterConfigLogging*`) are structurally-equivalent MIRRORS of
 * `cluster-tool`'s `BindConfig` / `Report.Config` / `LoggingConfig` — not
 * imports of them. `cluster-tool` depends on `debugging-shared`, so the
 * reverse import would form a dependency cycle; TypeScript's string-enum
 * values are structurally assignable to a plain string-literal-union type
 * (verified: a `Report.Format` value satisfies a `"csv" | "md" | "html"`
 * field with no cast), so `cluster-tool`'s actual enum-typed values still
 * satisfy these mirrored fields without any adapter code.
 */

import type { TokenAmount } from "@wireio/opp-typescript-models"

/**
 * Harness-local (chain, token) amount tuple. The previous proto-emitted
 * `ChainTokenAmount` was removed in the v6 data-model refactor — `Token.code`
 * is globally unique now, so the proto carries `TokenAmount` (just
 * `token_code` + `amount`) without a redundant chain tag. We still need the
 * chain dimension at the harness layer (per-underwriter collateral fans out
 * across `{ETH, SOL, WIRE}`), so this local shape pairs each `TokenAmount`
 * with its `chain_code` (slug_name / uint64).
 *
 * Persisted through `cluster-config.json` — `amount.amount` is `bigint`,
 * which `JSON.stringify` cannot serialise natively. {@link
 * serializeClusterConfig} / {@link deserializeClusterConfig} project the
 * field through the proto `TokenAmount`'s JSON helpers so the int64 round-
 * trips losslessly as a string.
 */
export interface ChainTokenAmount {
  /** SlugName / uint64 chain identifier (e.g. `SlugName.from("ETHEREUM")`). */
  chain_code: number
  /** Token amount carrying its own slug_name + int64 amount. */
  amount: TokenAmount
}

// ---------------------------------------------------------------------------
// Cluster filenames
// ---------------------------------------------------------------------------

/**
 * On-disk filenames for a cluster directory. The TUI and any other
 * out-of-process tooling read these to discover a cluster's config and
 * runtime state.
 */
export namespace ClusterFiles {
  /** Resolved cluster config written by `wire-cluster-tool create`. */
  export const ConfigFilename = "cluster-config.json" as const
  /** Serialized cluster state written after bootstrap. */
  export const StateFilename = "cluster-state.json" as const
  /**
   * Serialized `ClusterKeyStore` (per-node key sets + provisioned operator
   * accounts), written 0600. `cluster-tool`-private — NEVER served over the
   * debugging-server RPC surface.
   */
  export const KeysFilename = "cluster-keys.json" as const
}

// ---------------------------------------------------------------------------
// Executables
// ---------------------------------------------------------------------------

/** Absolute paths to the binaries a cluster needs to run. */
export interface ClusterExePaths {
  nodeop: string
  kiod: string
  clio: string
  sysUtil: string
  anvil: string
  solanaTestValidator: string
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** All ports claimed by a running cluster. Serialized into cluster-config.json. */
export interface ClusterPorts {
  /** kiod wallet daemon HTTP */
  kiod: number
  /** Bios node HTTP (only used during create bootstrap) */
  biosHttp: number
  /** Bios node P2P */
  biosP2p: number
  /** Producer node HTTP ports (one per node) */
  producerHttp: number[]
  /** Producer node P2P ports (one per node) */
  producerP2p: number[]
  /** Batch operator HTTP ports (one per node) */
  batchOperatorHttp: number[]
  /** Batch operator P2P ports (one per node) */
  batchOperatorP2p: number[]
  /** Underwriter HTTP ports (one per node) */
  underwriterHttp: number[]
  /** Underwriter P2P ports (one per node) */
  underwriterP2p: number[]
  /** Anvil (ETH) RPC */
  anvil: number
  /** Solana test validator RPC */
  solanaRpc: number
  /** Solana faucet */
  solanaFaucet: number
  /** Debugging server HTTP */
  debuggingServer: number
}

// ---------------------------------------------------------------------------
// Cluster state (v2) — post-bootstrap runtime snapshot
// ---------------------------------------------------------------------------

/**
 * `cluster-state.json` schema version. Bumped whenever the persisted shape
 * changes incompatibly; {@link ClusterState.version} lets a reader (or
 * `ClusterState.load` in `cluster-tool`) fail fast on a stale file instead of
 * silently misreading renamed/removed fields.
 */
export const ClusterStateVersion = 2 as const

/**
 * Role a cluster node plays. Identity-mapped string enum mirroring
 * `cluster-tool`'s `NodeRole` (`bios` / `producer` / `operator`) — declared
 * separately here (not imported) to keep `debugging-shared` free of a
 * dependency edge onto `cluster-tool`. The identical string values mean a
 * `cluster-tool` `NodeRole` member satisfies this type with no cast.
 */
export enum ClusterStateNodeRole {
  bios = "bios",
  producer = "producer",
  operator = "operator"
}

/** One `nodeop` instance's `{ http, p2p }` listen ports. */
export interface ClusterStateNodePorts {
  http: number
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
  /** Batch-operator account this node acts for, when `role === operator`. */
  batchOperatorAccount: string | null
  /** Underwriter account this node acts for, when `role === operator`. */
  underwriterAccount: string | null
}

/**
 * Post-bootstrap snapshot of cluster runtime layout. Written once by
 * `wire-cluster-tool create` (via `ClusterManager.create`'s persist phase)
 * and reloaded — read-only — by `run`, the debugging server, the TUI, and
 * `PidSources`. Secret-free by design: signing key material lives in the
 * separate `cluster-keys.json`, never here.
 */
export interface ClusterState {
  /** Schema version — see {@link ClusterStateVersion}. */
  version: typeof ClusterStateVersion
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

// ---------------------------------------------------------------------------
// Persisted cluster config (single-sourced from `cluster-tool`)
// ---------------------------------------------------------------------------
//
// The nested types below mirror `cluster-tool`'s `BindConfig` / `Report.Config`
// / `LoggingConfig` / `CollateralRequirement` field shapes exactly, without
// importing them (see the file header for why). Each is named for the
// concept it mirrors, prefixed `PersistedClusterConfig` per its parent.

/** Mirrors `cluster-tool`'s `BindConfigDaemon` — a daemon bound to one address + one port. */
export interface PersistedClusterConfigBindDaemon {
  address: string
  port: number
}

/** Mirrors `cluster-tool`'s `BindConfigNodeopPorts` — one nodeop's `{ http, p2p }` pair. */
export interface PersistedClusterConfigBindNodeopPorts {
  http: number
  p2p: number
}

/** Mirrors `cluster-tool`'s `BindConfigNodeopClusterPorts` — every nodeop's port pair, by role. */
export interface PersistedClusterConfigBindNodeopClusterPorts {
  bios: PersistedClusterConfigBindNodeopPorts
  producers: PersistedClusterConfigBindNodeopPorts[]
  batch: PersistedClusterConfigBindNodeopPorts[]
  underwriters: PersistedClusterConfigBindNodeopPorts[]
}

/** Mirrors `cluster-tool`'s `BindConfigNodeop` — nodeop bind address + the cluster-wide port set. */
export interface PersistedClusterConfigBindNodeop {
  address: string
  ports: PersistedClusterConfigBindNodeopClusterPorts
}

/** Mirrors `cluster-tool`'s `BindConfigPortRange` — an inclusive contiguous port window. */
export interface PersistedClusterConfigBindPortRange {
  first: number
  last: number
}

/** Mirrors `cluster-tool`'s `BindConfigSolanaPorts` — solana-test-validator's bound ports. */
export interface PersistedClusterConfigBindSolanaPorts {
  http: number
  faucet: number
  gossip: number
  dynamicRange: PersistedClusterConfigBindPortRange
}

/** Mirrors `cluster-tool`'s `BindConfigSolana` — solana bind address + its port set. */
export interface PersistedClusterConfigBindSolana {
  address: string
  ports: PersistedClusterConfigBindSolanaPorts
}

/**
 * Mirrors the persisted subset of `cluster-tool`'s `BindConfig` class
 * (`Pick<BindConfig, "kiod" | "nodeop" | "anvil" | "solana" | "debuggingServer">`).
 */
export interface PersistedClusterConfigBind {
  kiod: PersistedClusterConfigBindDaemon
  nodeop: PersistedClusterConfigBindNodeop
  anvil: PersistedClusterConfigBindDaemon
  solana: PersistedClusterConfigBindSolana
  debuggingServer: PersistedClusterConfigBindDaemon
}

/**
 * Mirrors `cluster-tool`'s `Report.Format` string enum (`csv` / `md` / `html`)
 * as a plain literal union — a `Report.Format` value satisfies this type
 * structurally, with no cast.
 */
export type PersistedClusterConfigReportFormat = "csv" | "md" | "html"

/** Mirrors `cluster-tool`'s `Report.Config` — the resolved report write target. */
export interface PersistedClusterConfigReport {
  path: string
  basename: string
  formats: PersistedClusterConfigReportFormat[]
}

/**
 * Mirrors `@wireio/shared`'s `Level` string enum as a plain literal union —
 * see {@link PersistedClusterConfigReportFormat} for why.
 */
export type PersistedClusterConfigLoggingLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal"

/** Mirrors `cluster-tool`'s `LoggingLevels` — per-sink log levels. */
export interface PersistedClusterConfigLoggingLevels {
  console: PersistedClusterConfigLoggingLevel
  file: PersistedClusterConfigLoggingLevel
}

/** Mirrors `cluster-tool`'s `LogFileAppender.Format` string enum (`text` / `jsonl`). */
export type PersistedClusterConfigLoggingFileFormat = "text" | "jsonl"

/** Mirrors `cluster-tool`'s `LoggingConfig` — resolved logging configuration. */
export interface PersistedClusterConfigLogging {
  levels: PersistedClusterConfigLoggingLevels
  fileFormat: PersistedClusterConfigLoggingFileFormat
}

/**
 * Mirrors `cluster-tool`'s `CollateralRequirement` — a per-(chain,token)
 * collateral minimum used by operator-eligibility config.
 */
export interface PersistedClusterConfigCollateralRequirement {
  chainCode: number
  tokenCode: number
  minimumBond: number
}

/** Mirrors `cluster-tool`'s local `ClusterExecutablePaths` — resolved binary locations. */
export interface PersistedClusterConfigExecutablePaths {
  nodeop: string
  kiod: string
  clio: string
  anvil: string
  solanaTestValidator: string
}

/**
 * The plain JSON shape persisted to `cluster-config.json`. Single-sourced
 * here — `cluster-tool`'s `ClusterConfig` imports this type rather than
 * declaring its own, so the harness and every debugging consumer agree on
 * exactly one persisted shape.
 */
export interface PersistedClusterConfig {
  buildPath: string
  clusterPath: string
  dataPath: string
  walletPath: string
  producerCount: number
  nodeCount: number
  batchOperatorCount: number
  underwriterCount: number
  epochDurationSec: number
  warmupEpochs: number
  cooldownEpochs: number
  ethereumPath: string
  solanaPath: string
  bind: PersistedClusterConfigBind
  executables: PersistedClusterConfigExecutablePaths
  report: PersistedClusterConfigReport
  logging: PersistedClusterConfigLogging
  requiredBatchOperatorCollateral: PersistedClusterConfigCollateralRequirement[]
  requiredUnderwriterCollateral: PersistedClusterConfigCollateralRequirement[]
  requiredProducerCollateral: PersistedClusterConfigCollateralRequirement[]
  underwriterCollateral: ChainTokenAmount[][] | null
  initialFinalizerKey: string | null
}
