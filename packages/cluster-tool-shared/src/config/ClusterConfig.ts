import type { Level } from "@wireio/shared"
import type { ChainTokenAmount } from "../types/ChainTokenAmount.js"
import type { BindConfig } from "./BindConfig.js"

/**
 * Report output format — value matches the file extension. THE one
 * declaration; `cluster-tool`'s `Report.Format` aliases it
 * (`export import Format = ClusterConfigReportFormat`).
 */
export enum ClusterConfigReportFormat {
  csv = "csv",
  md = "md",
  html = "html"
}

/** The resolved report write target (`Report.Config`'s persisted shape). */
export interface ClusterConfigReport {
  /** Absolute directory the report files are written into. */
  path: string
  /** Report file basename (`<path>/<basename>.<format>`). */
  basename: string
  /** Formats rendered on write. */
  formats: ClusterConfigReportFormat[]
}

/** Per-sink log levels (`@wireio/shared`'s `Level` identity string enum). */
export interface ClusterConfigLoggingLevels {
  /** Console sink level. */
  console: Level
  /** File sink level. */
  file: Level
}

/**
 * Log-file format. `jsonl` (one JSON object per line) is grep-/`jq`-friendly;
 * `text` is the human-readable console-style form. THE one declaration;
 * `cluster-tool`'s `LogFileAppender.Format` aliases it
 * (`export import Format = ClusterConfigLoggingFileFormat`).
 */
export enum ClusterConfigLoggingFileFormat {
  text = "text",
  jsonl = "jsonl"
}

/** Resolved logging configuration as persisted. */
export interface ClusterConfigLogging {
  /** Per-sink log levels. */
  levels: ClusterConfigLoggingLevels
  /** File-appender output format. */
  fileFormat: ClusterConfigLoggingFileFormat
}

/** Per-(chain,token) collateral minimum used by operator-eligibility config. */
export interface CollateralRequirement {
  /** SlugName / uint64 chain identifier. */
  chainCode: number
  /** SlugName / uint64 token identifier. */
  tokenCode: number
  /** Minimum bonded amount for eligibility, in the token's base units. */
  minimumBond: number
}

/** Absolute paths of the resolved binaries a cluster runs. */
export interface ClusterExecutablePaths {
  /** WIRE chain node. */
  nodeop: string
  /** Key daemon. */
  kiod: string
  /** WIRE CLI client. */
  clio: string
  /** Ethereum dev chain. */
  anvil: string
  /** Solana dev validator. */
  solanaTestValidator: string
}

/**
 * THE canonical cluster configuration — the plain JSON shape persisted to
 * `cluster-config.json` (`ClusterFiles.ConfigFilename`) and flowed through
 * the harness at runtime. `ClusterConfigProvider` (cluster-tool) resolves,
 * loads, and saves it; the debugging server, TUI, and flows consume it
 * read-only.
 */
export interface ClusterConfig {
  /** wire-sysio build directory (binaries + contract artifacts). */
  buildPath: string
  /** Root directory of this cluster's on-disk state. */
  clusterPath: string
  /** `<clusterPath>/data` — node data dirs, outpost state, OPP debugging. */
  dataPath: string
  /** `<clusterPath>/wallet` — the kiod wallet directory. */
  walletPath: string
  /** Number of producer accounts. */
  producerCount: number
  /** Number of producer nodes the producers are scheduled across. */
  nodeCount: number
  /** Number of batch-operator nodes. */
  batchOperatorCount: number
  /** Number of underwriter nodes. */
  underwriterCount: number
  /** Depot epoch duration, seconds (global — see the epoch-duration rule). */
  epochDurationSec: number
  /** Staking warmup, in epochs. */
  warmupEpochs: number
  /** Staking cooldown, in epochs. */
  cooldownEpochs: number
  /** wire-ethereum repo root. */
  ethereumPath: string
  /** wire-solana repo root. */
  solanaPath: string
  /** Resolved network binding for every daemon. */
  bind: BindConfig
  /** Resolved binary locations. */
  executables: ClusterExecutablePaths
  /** Report write target. */
  report: ClusterConfigReport
  /** Logging configuration. */
  logging: ClusterConfigLogging
  /** Batch-operator eligibility minimums, per (chain, token). */
  requiredBatchOperatorCollateral: CollateralRequirement[]
  /** Underwriter eligibility minimums, per (chain, token). */
  requiredUnderwriterCollateral: CollateralRequirement[]
  /** Producer eligibility minimums, per (chain, token). */
  requiredProducerCollateral: CollateralRequirement[]
  /**
   * Per-underwriter collateral fan-out (one row per underwriter, one entry
   * per chain), or `null` for the resolver's defaults. `null` (not absence)
   * so the slot round-trips through JSON persistence.
   */
  underwriterCollateral: ChainTokenAmount[][] | null
  /**
   * Genesis finalizer BLS public key, or `null` before key provisioning has
   * produced one. `null` (not absence) so the slot round-trips through JSON.
   */
  initialFinalizerKey: string | null
}
