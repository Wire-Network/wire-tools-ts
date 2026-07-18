import type {
  BindOptions,
  ChainTokenAmount,
  ClusterConfigLoggingFileFormat,
  ClusterConfigLoggingLevels,
  CollateralRequirement
} from "@wireio/cluster-tool-shared"
import type { Report } from "../report/Report.js"

/** Caller-facing logging options (the `Options` half of `ClusterConfigLogging`). */
export interface LoggingOptions {
  levels?: Partial<ClusterConfigLoggingLevels>
  fileFormat?: ClusterConfigLoggingFileFormat
}

/**
 * Everything a caller may set when standing up a cluster (CLI or flow). All
 * fields optional; `ClusterConfigProvider.resolve` fills the rest. `bind` / `report` /
 * `logging` are dedicated `Options` types — never `Partial<runtime-class>`.
 */
export interface ClusterBuildOptions {
  // paths
  buildPath?: string
  clusterPath?: string
  ethereumPath?: string
  solanaPath?: string
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
