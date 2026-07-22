import type { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import type { OppEnvelopeTelemetryObservation } from "./TelemetryHealthTypes.js"
import type { OppEnvelopeTelemetryIssue } from "./TelemetryIssueTypes.js"

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
  /** Optional phase-start timestamp; strict snapshots do not infer authority from file mtimes. */
  readonly timestampStartMs?: number
  /** Optional phase-end timestamp; strict snapshots do not infer authority from file mtimes. */
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

/** Candidate issue summary with its complete structured diagnostic. */
export type MalformedOppEnvelopeRecord = {
  /** Candidate base key, including an empty malformed key when discovered. */
  readonly key: string
  /** Exact serialized issue code without a policy-message prefix. */
  readonly reason: string
  /** Lossless structured issue carried beside the legacy key/reason fields. */
  readonly issue: OppEnvelopeTelemetryIssue
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
  /** Exact strict-reader candidate accounting and structured issues. */
  readonly health: OppEnvelopeTelemetryObservation
  /** Candidate issue summaries keyed for existing metric consumers. */
  readonly malformedRecords: readonly MalformedOppEnvelopeRecord[]
}

export type {
  DegradedOppEnvelopeTelemetryHealth,
  EmptyOppEnvelopeTelemetryHealth,
  HealthyOppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryCounts,
  OppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryObservation,
  PendingOppEnvelopeTelemetryHealth
} from "./TelemetryHealthTypes.js"
export { OppEnvelopeTelemetryHealthKind } from "./TelemetryHealthTypes.js"
export type { OppEnvelopeTelemetryIssue } from "./TelemetryIssueTypes.js"
export { OppEnvelopeTelemetryIssueCode } from "./TelemetryIssueTypes.js"
