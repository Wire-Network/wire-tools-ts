import type {
  EmptyOppEnvelopeTelemetryHealth,
  HealthyOppEnvelopeTelemetryHealth,
  MalformedOppEnvelopeRecord,
  OppPhaseEnvelopeMetrics,
  OppPhaseMetricEvidence,
  PendingOppEnvelopeTelemetryHealth,
  RunEvidenceDecimal
} from "@wireio/test-opp-stress"

import type { SwapStressPayoutObservation } from "./phaseRunnerTypes.js"

type MetricSummary = {
  readonly phase: string
  readonly saturated: boolean
  readonly envelopeCount: number
  readonly envelopeByteSizes: readonly number[]
  readonly endpoint: string
  readonly epochStart: RunEvidenceDecimal
  readonly epochEnd: RunEvidenceDecimal
}

type RecordedEvidence = Extract<
  OppPhaseMetricEvidence,
  { readonly kind: "recorded" }
>

type NotRecordedEvidence = Extract<
  OppPhaseMetricEvidence,
  { readonly kind: "not_recorded" }
>

type OppPhaseProjectionFields = Pick<
  OppPhaseEnvelopeMetrics,
  | "strategy"
  | "window"
  | "solanaOversized"
  | "epochEnvelopeIndexes"
  | "selectedArtifacts"
>

type OppPhaseProvenance<Evidence extends OppPhaseMetricEvidence> =
  OppPhaseProjectionFields & {
    readonly kind: "opp_phase"
    readonly evidence: Evidence
  }

type StrictSnapshotProvenance = {
  readonly kind: "strict_snapshot"
  readonly solanaOversized: boolean
  readonly epochEnvelopeIndexes: readonly number[]
}

/** Direct-flow metrics backed by an actual strict telemetry observation. */
export type SwapStressMeasuredPhaseEnvelopeMetrics = MetricSummary & {
  /** Confirms that telemetry collection produced an observation. */
  readonly measurement: "measured"
  /** Exact healthy strict-reader candidate accounting. */
  readonly health: HealthyOppEnvelopeTelemetryHealth
  /** Exact malformed candidate summaries from the strict projection. */
  readonly malformedRecords: readonly MalformedOppEnvelopeRecord[]
} & (
    | {
        /** Current strict snapshot provenance without baseline or evidence claims. */
        readonly provenance: StrictSnapshotProvenance
        /** Strict snapshots do not capture immutable run-evidence artifacts. */
        readonly artifactRefs: readonly []
      }
    | {
        /** Generic phase provenance with baseline correlation only. */
        readonly provenance: OppPhaseProvenance<NotRecordedEvidence>
        /** Baseline refs remain nested and are not phase-captured artifacts. */
        readonly artifactRefs: readonly []
      }
    | {
        /** Generic phase provenance with complete recorded evidence. */
        readonly provenance: OppPhaseProvenance<RecordedEvidence>
        /** Ordered immutable refs captured for this observation. */
        readonly artifactRefs: RecordedEvidence["artifactRefs"]
      }
  )

/** Retryable canonical telemetry retained without claiming measurement completion. */
export type SwapStressPendingPhaseEnvelopeMetrics = Omit<
  MetricSummary,
  "saturated"
> & {
  /** Confirms that canonical collection has not reached healthy completion. */
  readonly measurement: "pending"
  /** Pending publication cannot establish terminal saturation. */
  readonly saturated: false
  /** Exact retryable strict-reader health from the canonical observation. */
  readonly health:
    EmptyOppEnvelopeTelemetryHealth | PendingOppEnvelopeTelemetryHealth
  /** Exact malformed candidate summaries from the strict projection. */
  readonly malformedRecords: readonly MalformedOppEnvelopeRecord[]
} & (
    | {
        /** Generic pending provenance retaining baseline correlation. */
        readonly provenance: OppPhaseProvenance<NotRecordedEvidence>
        /** Correlation-only pending evidence does not claim captured artifacts. */
        readonly artifactRefs: readonly []
      }
    | {
        /** Generic pending provenance retaining its recorded observation. */
        readonly provenance: OppPhaseProvenance<RecordedEvidence>
        /** Ordered immutable refs captured for the pending observation. */
        readonly artifactRefs: RecordedEvidence["artifactRefs"]
      }
  )

/** Why direct-flow telemetry has no measured observation. */
export type SwapStressUnmeasuredReason =
  "collector_not_configured" | "collection_failed" | "phase_not_run"

/** Explicit zero summary for a phase with no telemetry observation. */
export type SwapStressUnmeasuredPhaseEnvelopeMetrics = {
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

/** Per-phase telemetry retained by the phase runner outcome. */
export type SwapStressPhaseResult = SwapStressPhaseEnvelopeMetrics & {
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
