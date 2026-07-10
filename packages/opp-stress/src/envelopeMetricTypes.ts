import type { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

/** Maximum OPP envelope payload size; changing it changes saturation ratios. */
export const MaxEnvelopeBytes = 65_536

/** Minimum raw OPP envelope bytes treated as near-cap saturation evidence. */
export const SaturatedEnvelopeMinBytes = Math.floor(MaxEnvelopeBytes * 0.95)

/** Solana raw transaction byte cap; changing it changes saturation classification. */
export const SolanaRawTransactionBytesMax = 1_232

/** OPP envelope saturation classification strategy. */
export type OppEnvelopeSaturationStrategy = "rollover" | "byte_threshold"

/** Inclusive filters for one OPP stress phase's envelope collection window. */
export type OppEnvelopeSaturationWindow = {
  /** Direction to count; omit or use UNKNOWN to include every direction. */
  readonly endpointsType?: DebugOutpostEndpointsType
  /** Inclusive epoch lower bound. */
  readonly epochStart?: number
  /** Inclusive epoch upper bound. */
  readonly epochEnd?: number
  /** Inclusive data-file mtime lower bound in Unix milliseconds. */
  readonly timestampStartMs?: number
  /** Inclusive data-file mtime upper bound in Unix milliseconds. */
  readonly timestampEndMs?: number
  /** Saturation classifier; defaults to rollover for generic OPP stress. */
  readonly saturationStrategy?: OppEnvelopeSaturationStrategy
}

/** Decoded OPP envelope metric used to decide whether one phase rolled over. */
export type OppEnvelopeMetric = {
  /** Storage key without `.data` / `.metadata`. */
  readonly key: string
  /** Source-side epoch index parsed from the storage key. */
  readonly epoch: number
  /** Endpoint direction parsed from the storage key. */
  readonly endpointsType: DebugOutpostEndpointsType
  /** Truncated checksum parsed from the storage key. */
  readonly checksum: string
  /** `Envelope.epochEnvelopeIndex`, used to detect rollover order. */
  readonly epochEnvelopeIndex: number
  /** Raw `.data` byte count. */
  readonly byteSize: number
  /** Raw byte-size saturation ratio against the OPP envelope cap. */
  readonly saturationRatio: number
  /** Batch-operator names recorded in the paired metadata file. */
  readonly batchOpNames: readonly string[]
}

/** Malformed fixture report for skipped envelope pairs. */
export type MalformedOppEnvelopeRecord = {
  /** Storage key without extension when available, otherwise the malformed base name. */
  readonly key: string
  /** Human-readable reason the pair could not be included. */
  readonly reason: string
}

/** Envelope saturation metrics for one OPP stress phase and direction/window. */
export type OppEnvelopeSaturationMetrics = {
  /** Whether matching records satisfy the selected saturation strategy. */
  readonly saturated: boolean
  /** Whether any matching Solana destination envelope exceeds the raw transaction byte cap. */
  readonly solanaOversized: boolean
  /** Number of valid matching envelopes. */
  readonly envelopeCount: number
  /** Matching raw envelope byte sizes in deterministic order. */
  readonly byteSizes: readonly number[]
  /** Matching `epochEnvelopeIndex` values in deterministic order. */
  readonly epochEnvelopeIndexes: readonly number[]
  /** Full per-envelope metric records in deterministic order. */
  readonly envelopes: readonly OppEnvelopeMetric[]
  /** Malformed pairs skipped during collection. */
  readonly malformedRecords: readonly MalformedOppEnvelopeRecord[]
}

/** Internal metric-read result used by the collector pipeline. */
export type ReadMetricResult =
  | { readonly kind: "metric"; readonly metric: OppEnvelopeMetric }
  | { readonly kind: "malformed"; readonly record: MalformedOppEnvelopeRecord }
  | { readonly kind: "filtered" }

/** Timestamp-window filter result used by metric readers. */
export type TimestampWindowResult =
  | { readonly kind: "matches"; readonly matches: boolean }
  | Extract<ReadMetricResult, { readonly kind: "malformed" }>
