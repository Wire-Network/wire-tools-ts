import { Level } from "@wireio/shared"
import { z } from "zod"

import { SchemaCodec } from "../schema/index.js"
import { ChainTokenAmountSchema } from "../types/ChainTokenAmount.js"
import { AWSClusterNodeConfigSchema } from "./AWSClusterNodeConfig.js"
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
 * Which command produced this cluster tree — controls production-shaped
 * rendering (SHARED-25 AC#4). `local` is what `create` writes; `external` is
 * stamped by `create-external-config`'s Rebind, and is the ONLY kind whose
 * bios / producer nodes drop `sysio::trace_api_plugin`.
 */
export enum ClusterDeploymentKind {
  local = "local",
  external = "external"
}

/**
 * SHARED-31's mandated `--chain-state-db-size-mb` default (MiB); equals
 * nodeop's stock chain-state-db-size-mb (1 GiB), so the always-emitted flag is
 * a no-op until an operator overrides it — uniformity by construction.
 * Raising it raises every node's chainbase mapping, on both commands and in
 * every emitted `start.sh`.
 */
export const DefaultChainStateDbSizeMb = 1_024

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
   * Genesis block-signing K1 public key (`genesis.json`'s `initial_key`) — the
   * bios node's authority. Under `KEY` / `KIOD` this is the well-known dev bios
   * key (byte-identical to every historical cluster); under `SSM` it is the
   * generated-or-adopted bios K1, which necessarily yields a DIFFERENT chain id.
   * Schema-defaulted to `null` so pre-existing configs stay loadable.
   */
  initialKey: z.string().nullable().default(null),
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
   * The cluster's AWS placement — the account its nodes run in, every region its
   * secrets are replicated to, and the SSM publish settings — or `null` when the
   * cluster has none. REQUIRED when `signatureProvider.type` is `SSM`: it
   * sources the secret-id `{cluster}` segment and the region set. Schema-defaulted
   * to `null` so pre-existing configs stay loadable.
   */
  awsClusterNodeConfig: AWSClusterNodeConfigSchema.nullable().default(null),
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
  enableMockReserves: z.boolean().default(false),
  /**
   * Whether the local Ethereum bootstrap deploys the transport-only synthetic
   * yield emitter. Schema-defaulted `false` so it is absent from the standard
   * local outpost surface.
   */
  enableMockYieldEmitter: z.boolean().default(false),
  /**
   * Which command produced this tree (SHARED-25 AC#4). Schema-defaulted
   * {@link ClusterDeploymentKind.local} so pre-existing configs — and every
   * `create`d cluster — keep `trace_api_plugin` on every role.
   */
  deploymentKind: z
    .enum(ClusterDeploymentKind)
    .default(ClusterDeploymentKind.local),
  /**
   * Uniform `--chain-state-db-size-mb` for EVERY nodeop node, both commands,
   * both phases (SHARED-31). Schema-defaulted to
   * {@link DefaultChainStateDbSizeMb} so pre-existing configs load as 1024 —
   * nodeop's own stock value, i.e. no behavior change until an operator
   * overrides it.
   */
  chainStateDbSizeMb: z.number().default(DefaultChainStateDbSizeMb)
})
/** THE canonical cluster configuration — the schema-inferred shape of {@link ClusterConfigSchema}. */
export type ClusterConfig = z.infer<typeof ClusterConfigSchema>

/** Validated codec for `cluster-config.json` (the single persistence surface). */
export const ClusterConfigSchemaCodec =
  SchemaCodec.create<ClusterConfig>(ClusterConfigSchema)
