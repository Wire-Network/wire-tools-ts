import type { ChainTokenAmount } from "@wireio/debugging-shared"
import type { Level } from "@wireio/shared"
import type { LogFileAppender } from "../logging/LogFileAppender.js"
import type { Report } from "../report/Report.js"
import type { BindOptions } from "./BindConfig.js"

/** Per-sink log levels. */
export interface LoggingLevels {
  console: Level
  file: Level
}

/** Resolved logging configuration (the `Config` half). */
export interface LoggingConfig {
  levels: LoggingLevels
  fileFormat: LogFileAppender.Format
}

/** Caller-facing logging options (the `Options` half) — distinct from `LoggingConfig`. */
export interface LoggingOptions {
  levels?: Partial<LoggingLevels>
  fileFormat?: LogFileAppender.Format
}

/** Per-(chain,token) collateral minimum used by operator-eligibility config. */
export interface CollateralRequirement {
  chainCode: number
  tokenCode: number
  minimumBond: number
}

/**
 * Everything a caller may set when standing up a cluster (CLI or flow). All
 * fields optional; `ClusterConfig.resolve` fills the rest. `bind` / `report` /
 * `logging` are dedicated `Options` types — never `Partial<runtime-class>`.
 */
export interface ClusterBuildOptions {
  // paths
  buildPath?: string
  clusterPath?: string
  ethereumPath?: string
  solanaPath?: string
  clusterConfigPath?: string
  force?: boolean
  // topology
  producerCount?: number
  nodeCount?: number
  batchOperatorCount?: number
  underwriterCount?: number
  // epoch
  epochDurationSec?: number
  warmupEpochs?: number
  cooldownEpochs?: number
  // network binding
  bindAll?: boolean
  bind?: BindOptions
  // termination tuning
  terminateMaxConsecutiveMisses?: number
  terminateMaxPercentMisses24h?: number
  terminateWindowMs?: number
  // collateral
  requiredProducerCollateral?: CollateralRequirement[]
  requiredBatchOperatorCollateral?: CollateralRequirement[]
  requiredUnderwriterCollateral?: CollateralRequirement[]
  underwriterCollateral?: ChainTokenAmount[][]
  // outputs
  report?: Report.Options
  logging?: LoggingOptions
}
