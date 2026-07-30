import type {
  AWSClusterNodeConfig,
  BindOptions,
  ChainTokenAmount,
  ClusterConfigLoggingFileFormat,
  ClusterConfigLoggingLevels,
  ClusterSignatureProviderOptions,
  CollateralRequirement
} from "@wireio/cluster-tool-shared"
import type { Report } from "../report/Report.js"

/** Caller-facing logging options (the `Options` half of `ClusterConfigLogging`). */
export interface LoggingOptions {
  levels?: Partial<ClusterConfigLoggingLevels>
  fileFormat?: ClusterConfigLoggingFileFormat
}

/** Caller-facing Ethereum-chain options (the `Options` half of `ClusterConfigEthereum`). */
export interface EthereumOptions {
  /** Ethereum prelaunch balance dump imported into `sysio.dclaim` during cluster creation. */
  bootstrapJsonFile?: string
}

/** Caller-facing Solana-chain options (the `Options` half of `ClusterConfigSolana`). */
export interface SolanaOptions {
  /** Solana prelaunch balance dump imported into `sysio.dclaim` during cluster creation. */
  bootstrapJsonFile?: string
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
  /** `operators_per_epoch` (batch-op group SIZE) — omit to derive from `batchOperatorCount`. */
  operatorsPerEpoch?: number
  /** `batch_op_groups` (group COUNT) — omit to derive from `batchOperatorCount`. */
  batchOpGroups?: number
  /** `epoch_retention_envelope_log_count` — omit for the bootstrap default. */
  epochRetentionEnvelopeLogCount?: number
  warmupEpochs?: number
  cooldownEpochs?: number
  // per-chain inputs
  ethereum?: EthereumOptions
  solana?: SolanaOptions
  // network binding
  bindAll?: boolean
  bind?: BindOptions
  // mock data seeding
  /**
   * Seed the 8 mock (chain, token) PRIMARY reserves at bootstrap
   * (`--enable-mock-reserves`). Default `false` at every layer — an
   * external / real-world depot gets NO fake reserves unless a caller (or a
   * flow's scenario `defaults`) opts in. The depot contract gates `regreserve`
   * to the bootstrap window (epoch 0), so this only ever seeds pre-EpochBootstrap.
   */
  enableMockReserves?: boolean
  // nodeop tuning
  /**
   * Uniform nodeop chain-state DB size in MiB for every node (SHARED-31). Omit
   * for the 1024 default (`DefaultChainStateDbSizeMb` — nodeop's own stock
   * value, so the always-emitted flag is a no-op until it is overridden).
   */
  chainStateDbSizeMb?: number
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
  // signature provider — how the cluster's own signing keys are handled (default KEY)
  signatureProvider?: ClusterSignatureProviderOptions
  /**
   * The cluster's AWS placement (account + replication regions + SSM publish
   * settings). REQUIRED when `signatureProvider.type` is `SSM` — it sources the
   * secret-id `{cluster}` segment and the region set every secret is replicated
   * to. Accepted but unused under `KEY` / `KIOD`.
   */
  awsClusterNodeConfig?: AWSClusterNodeConfig
  // external inputs (file paths → `--bind-config` / `--external-outpost-config`)
  bindConfig?: string
  externalOutpostConfig?: string
}
