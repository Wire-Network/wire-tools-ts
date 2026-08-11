import type { EnvelopeBaseline, EnvelopeBaselineCaptureResult, EnvelopeIntegrityIssueSequence } from "../envelope-integrity/index.js"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import type {
  EmptyOppEnvelopeTelemetryHealth,
  HealthyOppEnvelopeTelemetryHealth,
  OppPhaseEnvelopeMetrics,
  PendingOppEnvelopeTelemetryHealth
} from "../stress-engine/index.js"

import type {
  SwapStressMeasuredPhaseEnvelopeMetrics,
  SwapStressPhaseEnvelopeMetrics
} from "./phaseRunnerMetricTypes.js"
import type { SwapStressPhase } from "./phaseRunnerTypes.js"

/**
 * The phase + direction identity of an observation, without its time window —
 * everything telemetry preparation needs before any phase work has run.
 */
export interface SwapStressMetricWindowIdentity {
  /** Phase whose window is being measured. */
  readonly phase: SwapStressPhase
  /** Direction expected to carry the phase envelopes. */
  readonly endpointsType: DebugOutpostEndpointsType
}

/** Shared phase window fields for synthetic and baseline-correlated collectors. */
export interface SwapStressMetricWindow
  extends SwapStressMetricWindowIdentity {
  /** Inclusive phase start timestamp. */
  readonly startedAtMs: number
  /** Inclusive phase end timestamp. */
  readonly endedAtMs: number
}

/** The absent-baseline leg of a synthetic metric request. */
interface SwapStressSyntheticBaselineAbsence {
  /** Synthetic collection cannot claim a real pre-phase baseline. */
  readonly baseline?: never
}

/** Baseline-free request accepted only by synthetic collectors. */
export type SwapStressSyntheticEnvelopeMetricRequest = SwapStressMetricWindow &
  SwapStressSyntheticBaselineAbsence

/** The captured-baseline leg of a real metric request. */
interface SwapStressCapturedBaseline {
  /** Exact all-key baseline captured before phase work begins. */
  readonly baseline: EnvelopeBaseline
}

/** Real metric request correlated to one caller-captured pre-phase baseline. */
export type SwapStressEnvelopeMetricRequest = SwapStressMetricWindow &
  SwapStressCapturedBaseline

/** The retryable narrowing layered over generic phase telemetry. */
interface SwapStressPendingObservationNarrowing {
  /** Pending evidence is never terminal saturation evidence. */
  readonly saturated: false
  /** Empty and pending-publication are the only retryable collector states. */
  readonly health:
    | EmptyOppEnvelopeTelemetryHealth
    | PendingOppEnvelopeTelemetryHealth
}

/** Retryable generic telemetry that cannot claim flow saturation. */
export type SwapStressPendingPhaseObservation = OppPhaseEnvelopeMetrics &
  SwapStressPendingObservationNarrowing

/** Degradation caused by a failed pre-phase baseline capture. */
interface SwapStressBaselineCaptureFailedDegradation {
  /** Baseline discovery failed before phase work could be correlated. */
  readonly kind: "baseline_capture_failed"
  /** Ordered non-empty strict-reader issues returned by baseline capture. */
  readonly issues: EnvelopeIntegrityIssueSequence
}

/** Degradation caused by an expired telemetry deadline. */
interface SwapStressDeadlineExhaustedDegradation {
  /** Existing telemetry deadline expired with a retryable final observation. */
  readonly kind: "deadline_exhausted"
  /** Exact final pending observation retained for evidence. */
  readonly observation: SwapStressPendingPhaseObservation
}

/** Exact structured causes that later deadline policy may terminalize. */
export type SwapStressTelemetryDegradation =
  | SwapStressBaselineCaptureFailedDegradation
  | SwapStressDeadlineExhaustedDegradation

/** `Extract` filter selecting the deadline-exhausted degradation leg. */
interface SwapStressDeadlineExhaustedDiscriminator {
  readonly kind: "deadline_exhausted"
}

type SwapStressDeadlineTelemetryDegradation = Extract<
  SwapStressTelemetryDegradation,
  SwapStressDeadlineExhaustedDiscriminator
>

/** Typed terminal error reserved for real telemetry integrity degradation. */
export class SwapStressTelemetryDegradedError<
  Degradation extends SwapStressTelemetryDegradation =
    SwapStressTelemetryDegradation
> extends Error {
  /** Stable runtime error identity. */
  readonly name = "SwapStressTelemetryDegradedError"
  /** Ramp/evidence category distinguishing telemetry integrity from infrastructure errors. */
  readonly category = "telemetry_integrity" as const

  /**
   * Create a typed terminal telemetry error.
   *
   * @param phase Phase whose telemetry degraded.
   * @param endpointsType Endpoint direction whose evidence degraded.
   * @param degradation Exact typed degradation details.
   */
  constructor(
    readonly phase: SwapStressPhase,
    readonly endpointsType: DebugOutpostEndpointsType,
    readonly degradation: Degradation
  ) {
    super(
      `${phase} ${DebugOutpostEndpointsType[endpointsType]} OPP telemetry degraded`
    )
  }
}

/** The healthy-telemetry narrowing applied to measured phase metrics. */
export interface SwapStressHealthyMetricNarrowing {
  readonly health: HealthyOppEnvelopeTelemetryHealth
}

/** Collection that produced healthy, measured flow metrics. */
export interface SwapStressMeasuredCollectionResult {
  /** Healthy generic telemetry projected into measured flow metrics. */
  readonly kind: "measured"
  /** Full measured metrics statically narrowed to healthy telemetry. */
  readonly metrics: SwapStressMeasuredPhaseEnvelopeMetrics &
    SwapStressHealthyMetricNarrowing
}

/** Collection that produced a retryable, unsaturated observation. */
interface SwapStressPendingCollectionResult {
  /** Retryable empty or incomplete publication retained as data. */
  readonly kind: "pending"
  /** Exact unsaturated generic observation. */
  readonly observation: SwapStressPendingPhaseObservation
}

/** Collection terminalized by deadline policy. */
export interface SwapStressDegradedCollectionResult {
  /** Terminal degradation created only by later deadline policy. */
  readonly kind: "degraded"
  /** Typed error carrying the exact final pending deadline evidence. */
  readonly error: SwapStressTelemetryDegradedError<SwapStressDeadlineTelemetryDegradation>
}

/** Exhaustive canonical result of one real baseline-correlated collection. */
export type SwapStressEnvelopeMetricCollectionResult =
  | SwapStressMeasuredCollectionResult
  | SwapStressPendingCollectionResult
  | SwapStressDegradedCollectionResult

/** Optional synthetic phase metric collector. */
export type SwapStressSyntheticEnvelopeMetricCollector = (
  request: SwapStressSyntheticEnvelopeMetricRequest
) => Promise<SwapStressPhaseEnvelopeMetrics>

/** Required canonical real collector consuming a caller-provided baseline. */
export type SwapStressEnvelopeMetricCollector = (
  request: SwapStressEnvelopeMetricRequest
) => Promise<SwapStressEnvelopeMetricCollectionResult>

/** Required telemetry capabilities for real phase execution. */
export interface SwapStressRealTelemetryDeps {
  /** Real dependency discriminant. */
  readonly telemetryKind: "real"
  /** Capture the canonical OPP all-key baseline for one phase. */
  readonly captureEnvelopeBaseline: () => Promise<EnvelopeBaselineCaptureResult>
  /** Collect canonical phase metrics correlated to the supplied baseline. */
  readonly collectEnvelopeMetrics: SwapStressEnvelopeMetricCollector
}

/** Synthetic telemetry capabilities, which cannot capture or claim real baselines. */
export interface SwapStressSyntheticTelemetryDeps {
  /** Synthetic dependency discriminant. */
  readonly telemetryKind: "synthetic"
  /** Synthetic runners cannot capture real baselines. */
  readonly captureEnvelopeBaseline?: never
  /** Optional synthetic metrics preserve honest unmeasured behavior when omitted. */
  readonly collectEnvelopeMetrics?: SwapStressSyntheticEnvelopeMetricCollector
}

/** Complete discriminated telemetry dependency contract for the phase runner. */
export type SwapStressTelemetryDeps =
  SwapStressRealTelemetryDeps | SwapStressSyntheticTelemetryDeps
