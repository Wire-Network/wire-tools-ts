import { Level } from "@wireio/shared"
import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"
import { ChainTokenAmountSchema } from "../types/ChainTokenAmount.js"
import { BindConfigSchema } from "./BindConfig.js"
import { ClusterSignatureProviderConfigSchema } from "./SignatureProviderConfig.js"
import { ExternalOutpostConfigSchema } from "./ExternalOutpostConfig.js"

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
export const ClusterConfigReportSchema = z.object({
  /** Absolute directory the report files are written into. */
  path: z.string(),
  /** Report file basename (`<path>/<basename>.<format>`). */
  basename: z.string(),
  /** Formats rendered on write. */
  formats: z.array(z.enum(ClusterConfigReportFormat))
})
/** The resolved report write target — the shape of {@link ClusterConfigReportSchema}. */
export type ClusterConfigReport = z.infer<typeof ClusterConfigReportSchema>

/** Per-sink log levels (`@wireio/shared`'s `Level` identity string enum). */
export const ClusterConfigLoggingLevelsSchema = z.object({
  /** Console sink level. */
  console: z.enum(Level),
  /** File sink level. */
  file: z.enum(Level)
})
/** Per-sink log levels — the shape of {@link ClusterConfigLoggingLevelsSchema}. */
export type ClusterConfigLoggingLevels = z.infer<
  typeof ClusterConfigLoggingLevelsSchema
>

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
export const ClusterConfigLoggingSchema = z.object({
  /** Per-sink log levels. */
  levels: ClusterConfigLoggingLevelsSchema,
  /** File-appender output format. */
  fileFormat: z.enum(ClusterConfigLoggingFileFormat)
})
/** Resolved logging configuration — the shape of {@link ClusterConfigLoggingSchema}. */
export type ClusterConfigLogging = z.infer<typeof ClusterConfigLoggingSchema>

/** Per-(chain,token) collateral minimum used by operator-eligibility config. */
export const CollateralRequirementSchema = z.object({
  /** SlugName / uint64 chain identifier. */
  chainCode: z.number(),
  /** SlugName / uint64 token identifier. */
  tokenCode: z.number(),
  /** Minimum bonded amount for eligibility, in the token's base units. */
  minimumBond: z.number()
})
/** Per-(chain,token) collateral minimum — the shape of {@link CollateralRequirementSchema}. */
export type CollateralRequirement = z.infer<typeof CollateralRequirementSchema>

/** Absolute paths of the resolved binaries a cluster runs. */
export const ClusterExecutablePathsSchema = z.object({
  /** WIRE chain node. */
  nodeop: z.string(),
  /** Key daemon. */
  kiod: z.string(),
  /** WIRE CLI client. */
  clio: z.string(),
  /** Ethereum dev chain. */
  anvil: z.string(),
  /** Solana dev validator. */
  solanaTestValidator: z.string()
})
/** Absolute paths of the resolved binaries — the shape of {@link ClusterExecutablePathsSchema}. */
export type ClusterExecutablePaths = z.infer<
  typeof ClusterExecutablePathsSchema
>

/**
 * THE canonical cluster configuration — the plain JSON shape persisted to
 * `cluster-config.json` (`ClusterFiles.ConfigFilename`) and flowed through
 * the harness at runtime. `ClusterConfigProvider` (cluster-tool) resolves,
 * loads, and saves it (via {@link ClusterConfigSchemaCodec}); the debugging
 * server, TUI, and flows consume it read-only.
 */
export const ClusterConfigSchema = z.object({
  /** wire-sysio build directory (binaries + contract artifacts). */
  buildPath: z.string(),
  /** Root directory of this cluster's on-disk state. */
  clusterPath: z.string(),
  /** `<clusterPath>/data` — node data dirs, outpost state, OPP debugging. */
  dataPath: z.string(),
  /** `<clusterPath>/wallet` — the kiod wallet directory. */
  walletPath: z.string(),
  /** Number of producer accounts. */
  producerCount: z.number(),
  /** Number of producer nodes the producers are scheduled across. */
  nodeCount: z.number(),
  /** Number of batch-operator nodes. */
  batchOperatorCount: z.number(),
  /** Number of underwriter nodes. */
  underwriterCount: z.number(),
  /** Depot epoch duration, seconds (global — see the epoch-duration rule). */
  epochDurationSec: z.number(),
  /**
   * `operators_per_epoch` (batch-op group SIZE) override, or `null` to derive
   * it from `batchOperatorCount` at bootstrap. `null` (not absence) so the slot
   * round-trips through JSON persistence.
   */
  operatorsPerEpoch: z.number().nullable().default(null),
  /**
   * `batch_op_groups` (group COUNT) override, or `null` to derive it from
   * `batchOperatorCount` at bootstrap. `null` (not absence) so the slot
   * round-trips through JSON persistence.
   */
  batchOpGroups: z.number().nullable().default(null),
  /**
   * `epoch_retention_envelope_log_count` override, or `null` for the bootstrap
   * default. `null` (not absence) so the slot round-trips through JSON.
   */
  epochRetentionEnvelopeLogCount: z.number().nullable().default(null),
  /** Staking warmup, in epochs. */
  warmupEpochs: z.number(),
  /** Staking cooldown, in epochs. */
  cooldownEpochs: z.number(),
  /**
   * `terminate_max_consecutive_misses` override, or `null` for the dev default.
   * `null` (not absence) so the slot round-trips through JSON persistence.
   */
  terminateMaxConsecutiveMisses: z.number().nullable().default(null),
  /**
   * `terminate_max_pct_misses_24h` override, or `null` for the dev default.
   * `null` (not absence) so the slot round-trips through JSON persistence.
   */
  terminateMaxPercentMisses24h: z.number().nullable().default(null),
  /**
   * `terminate_window_ms` override, or `null` for the dev default (24h).
   * `null` (not absence) so the slot round-trips through JSON persistence.
   */
  terminateWindowMs: z.number().nullable().default(null),
  /**
   * Warp the solana-test-validator past Solana epoch 3 at launch, so a flow
   * driving `flush_staking_yield` (which requires `Clock.epoch >= 3`) can run.
   * Off for every flow except `flow-yield-distribution`, which opts in via its
   * scenario `defaults`: warping advances the Solana clock minutes ahead, which
   * trips the depot's `sysio.authex` 10-minute nonce window on cross-chain SOL
   * deposits — so no swap/deposit flow may enable it.
   */
  solanaEpochWarp: z.boolean().default(false),
  /** wire-ethereum repo root. */
  ethereumPath: z.string(),
  /** wire-solana repo root. */
  solanaPath: z.string(),
  /** Resolved network binding for every daemon. */
  bind: BindConfigSchema,
  /** Resolved binary locations. */
  executables: ClusterExecutablePathsSchema,
  /** Report write target. */
  report: ClusterConfigReportSchema,
  /** Logging configuration. */
  logging: ClusterConfigLoggingSchema,
  /** Batch-operator eligibility minimums, per (chain, token). */
  requiredBatchOperatorCollateral: z.array(CollateralRequirementSchema),
  /** Underwriter eligibility minimums, per (chain, token). */
  requiredUnderwriterCollateral: z.array(CollateralRequirementSchema),
  /** Producer eligibility minimums, per (chain, token). */
  requiredProducerCollateral: z.array(CollateralRequirementSchema),
  /**
   * Per-underwriter collateral fan-out (one row per underwriter, one entry
   * per chain), or `null` for the resolver's defaults. `null` (not absence)
   * so the slot round-trips through JSON persistence.
   */
  underwriterCollateral: z.array(z.array(ChainTokenAmountSchema)).nullable(),
  /**
   * Genesis finalizer BLS public key, or `null` before key provisioning has
   * produced one. `null` (not absence) so the slot round-trips through JSON.
   */
  initialFinalizerKey: z.string().nullable(),
  /**
   * Cluster signature-provider config (how the cluster's own signing keys are
   * handled). Schema-defaulted to `{ type: KEY, ssm: null }` so pre-existing
   * configs stay loadable.
   */
  signatureProvider: ClusterSignatureProviderConfigSchema,
  /**
   * Already-deployed outposts to run against (external-outpost mode), or `null`
   * for the standard local-anvil/local-solana bootstrap. Schema-defaulted to
   * `null` so pre-existing configs stay loadable.
   */
  externalOutposts: ExternalOutpostConfigSchema.nullable().default(null),
  /**
   * Whether operator daemons load the OPP-debugging sink plugin AND the cluster
   * starts the debugging server. Schema-defaulted `true`; persisted `false` by
   * `create-external-config --no-debugging-server` (run without a debugging server).
   */
  debuggingServerEnabled: z.boolean().default(true),
  /**
   * Whether the bootstrap seeds the 8 mock (chain, token) PRIMARY reserves
   * (the `--enable-mock-reserves` create flag). Schema-defaulted `false` so
   * pre-existing configs — and every real/external depot — stay reserve-free
   * unless a caller (or a flow's scenario defaults) opts in.
   */
  enableMockReserves: z.boolean().default(false)
})
/** THE canonical cluster configuration — the schema-inferred shape of {@link ClusterConfigSchema}. */
export type ClusterConfig = z.infer<typeof ClusterConfigSchema>

/** Validated codec for `cluster-config.json` (the single persistence surface). */
export const ClusterConfigSchemaCodec =
  SchemaCodec.create<ClusterConfig>(ClusterConfigSchema)
