import type {
  EmptyOppEnvelopeTelemetryHealth,
  HealthyOppEnvelopeTelemetryHealth,
  MalformedOppEnvelopeRecord,
  OppPhaseEnvelopeMetrics,
  OppPhaseMetricEvidence,
  PendingOppEnvelopeTelemetryHealth,
  RunEvidenceDecimal
} from "../stress-engine/index.js"

import type { SwapStressPayoutObservation } from "./phaseRunnerTypes.js"

interface MetricSummary {
  readonly phase: string
  readonly saturated: boolean
  readonly envelopeCount: number
  readonly envelopeByteSizes: readonly number[]
  readonly endpoint: string
  readonly epochStart: RunEvidenceDecimal
  readonly epochEnd: RunEvidenceDecimal
}

/** `Extract` filter selecting the recorded leg of the generic phase evidence. */
interface RecordedEvidenceDiscriminator {
  readonly kind: "recorded"
}

/** `Extract` filter selecting the correlation-only leg of the phase evidence. */
interface NotRecordedEvidenceDiscriminator {
  readonly kind: "not_recorded"
}

type RecordedEvidence = Extract<
  OppPhaseMetricEvidence,
  RecordedEvidenceDiscriminator
>

type NotRecordedEvidence = Extract<
  OppPhaseMetricEvidence,
  NotRecordedEvidenceDiscriminator
>

/**
 * The `OppPhaseEnvelopeMetrics` fields a swap-stress phase provenance projects.
 * Each member type is an indexed access on the generated metrics interface, so
 * the projection tracks it without re-spelling a `Pick` key literal union.
 */
interface OppPhaseProjectionFields {
  readonly strategy: OppPhaseEnvelopeMetrics["strategy"]
  readonly window: OppPhaseEnvelopeMetrics["window"]
  readonly solanaOversized: OppPhaseEnvelopeMetrics["solanaOversized"]
  readonly epochEnvelopeIndexes: OppPhaseEnvelopeMetrics["epochEnvelopeIndexes"]
  readonly selectedArtifacts: OppPhaseEnvelopeMetrics["selectedArtifacts"]
}

/** The generic-phase provenance discriminator and its evidence leg. */
interface OppPhaseProvenanceEvidence<
  Evidence extends OppPhaseMetricEvidence
> {
  readonly kind: "opp_phase"
  readonly evidence: Evidence
}

type OppPhaseProvenance<Evidence extends OppPhaseMetricEvidence> =
  OppPhaseProjectionFields & OppPhaseProvenanceEvidence<Evidence>

interface StrictSnapshotProvenance {
  readonly kind: "strict_snapshot"
  readonly solanaOversized: boolean
  readonly epochEnvelopeIndexes: readonly number[]
}

/** The measured-observation fields layered over the shared metric summary. */
interface MeasuredPhaseEnvelopeFields {
  /** Confirms that telemetry collection produced an observation. */
  readonly measurement: "measured"
  /** Exact healthy strict-reader candidate accounting. */
  readonly health: HealthyOppEnvelopeTelemetryHealth
  /** Exact malformed candidate summaries from the strict projection. */
  readonly malformedRecords: readonly MalformedOppEnvelopeRecord[]
}

/** Measured variant backed by a current strict snapshot. */
interface MeasuredStrictSnapshotProvenanceFields {
  /** Current strict snapshot provenance without baseline or evidence claims. */
  readonly provenance: StrictSnapshotProvenance
  /** Strict snapshots do not capture immutable run-evidence artifacts. */
  readonly artifactRefs: readonly []
}

/** Measured variant carrying baseline correlation only. */
interface MeasuredCorrelationProvenanceFields {
  /** Generic phase provenance with baseline correlation only. */
  readonly provenance: OppPhaseProvenance<NotRecordedEvidence>
  /** Baseline refs remain nested and are not phase-captured artifacts. */
  readonly artifactRefs: readonly []
}

/** Measured variant carrying complete recorded evidence. */
interface MeasuredRecordedProvenanceFields {
  /** Generic phase provenance with complete recorded evidence. */
  readonly provenance: OppPhaseProvenance<RecordedEvidence>
  /** Ordered immutable refs captured for this observation. */
  readonly artifactRefs: RecordedEvidence["artifactRefs"]
}

/** Direct-flow metrics backed by an actual strict telemetry observation. */
export type SwapStressMeasuredPhaseEnvelopeMetrics = MetricSummary &
  MeasuredPhaseEnvelopeFields &
  (
    | MeasuredStrictSnapshotProvenanceFields
    | MeasuredCorrelationProvenanceFields
    | MeasuredRecordedProvenanceFields
  )

/** The pending-observation fields layered over the shared metric summary. */
interface PendingPhaseEnvelopeFields {
  /** Confirms that canonical collection has not reached healthy completion. */
  readonly measurement: "pending"
  /** Pending publication cannot establish terminal saturation. */
  readonly saturated: false
  /** Exact retryable strict-reader health from the canonical observation. */
  readonly health:
    | EmptyOppEnvelopeTelemetryHealth
    | PendingOppEnvelopeTelemetryHealth
  /** Exact malformed candidate summaries from the strict projection. */
  readonly malformedRecords: readonly MalformedOppEnvelopeRecord[]
}

/** Pending variant retaining baseline correlation only. */
interface PendingCorrelationProvenanceFields {
  /** Generic pending provenance retaining baseline correlation. */
  readonly provenance: OppPhaseProvenance<NotRecordedEvidence>
  /** Correlation-only pending evidence does not claim captured artifacts. */
  readonly artifactRefs: readonly []
}

/** Pending variant retaining its recorded observation. */
interface PendingRecordedProvenanceFields {
  /** Generic pending provenance retaining its recorded observation. */
  readonly provenance: OppPhaseProvenance<RecordedEvidence>
  /** Ordered immutable refs captured for the pending observation. */
  readonly artifactRefs: RecordedEvidence["artifactRefs"]
}

/** Retryable canonical telemetry retained without claiming measurement completion. */
export type SwapStressPendingPhaseEnvelopeMetrics = Omit<
  MetricSummary,
  "saturated"
> &
  PendingPhaseEnvelopeFields &
  (PendingCorrelationProvenanceFields | PendingRecordedProvenanceFields)

/** Why direct-flow telemetry has no measured observation. */
export enum SwapStressUnmeasuredReasonKind {
  collector_not_configured = "collector_not_configured",
  collection_failed = "collection_failed",
  phase_not_run = "phase_not_run"
}

/**
 * Why direct-flow telemetry has no measured observation — derived from
 * {@link SwapStressUnmeasuredReasonKind} so raw spellings stay assignable.
 */
export type SwapStressUnmeasuredReason = `${SwapStressUnmeasuredReasonKind}`

/** Explicit zero summary for a phase with no telemetry observation. */
export interface SwapStressUnmeasuredPhaseEnvelopeMetrics {
  /** Confirms that no telemetry observation exists. */
  readonly measurement: "unmeasured"
  /** Exact reason no observation exists. */
  readonly unmeasuredReason: SwapStressUnmeasuredReason
  /** Phase or classifier label these metrics describe. */
  readonly phase: string
  /** Unmeasured phases cannot claim saturation. */
  readonly saturated: false
  /** Literal zero because no envelope observation exists. */
  readonly envelopeCount: 0
  /** Literal empty tuple because no envelope observation exists. */
  readonly envelopeByteSizes: readonly []
  /** Expected endpoint label retained for classification diagnostics. */
  readonly endpoint: string
  /** Literal zero because no epoch window was observed. */
  readonly epochStart: "0"
  /** Literal zero because no epoch window was observed. */
  readonly epochEnd: "0"
  /** Null distinguishes absence from fabricated healthy telemetry. */
  readonly health: null
  /** No malformed records can be claimed without collection. */
  readonly malformedRecords: readonly []
  /** No immutable artifacts can be claimed without collection. */
  readonly artifactRefs: readonly []
  /** Null distinguishes absence from fabricated provenance. */
  readonly provenance: null
}

/** Honest canonical or explicitly unmeasured flow telemetry. */
export type SwapStressPhaseEnvelopeMetrics =
  | SwapStressMeasuredPhaseEnvelopeMetrics
  | SwapStressPendingPhaseEnvelopeMetrics
  | SwapStressUnmeasuredPhaseEnvelopeMetrics

/** The per-phase runner fields layered over the phase telemetry metrics. */
interface SwapStressPhaseResultFields {
  /** Phase transaction successes. */
  readonly txSuccesses: number
  /** Phase transaction failures. */
  readonly txFailures: number
  /** Phase observation start timestamp. */
  readonly observationStartedAtMs: number
  /** Phase observation end timestamp. */
  readonly observationEndedAtMs: number
  /** Observed remit payouts for the phase. */
  readonly payout: SwapStressPayoutObservation | null
}

/** Per-phase telemetry retained by the phase runner outcome. */
export type SwapStressPhaseResult = SwapStressPhaseEnvelopeMetrics &
  SwapStressPhaseResultFields
