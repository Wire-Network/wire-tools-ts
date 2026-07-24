import type {
  EnvelopeBaseline,
  EnvelopeBaselineCaptureResult,
  EnvelopeIntegrityIssueSequence
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import type {
  EmptyOppEnvelopeTelemetryHealth,
  HealthyOppEnvelopeTelemetryHealth,
  OppPhaseEnvelopeMetrics,
  PendingOppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"

import type {
  SwapStressMeasuredPhaseEnvelopeMetrics,
  SwapStressPhaseEnvelopeMetrics
} from "./phaseRunnerMetricTypes.js"
import type { SwapStressPhase } from "./phaseRunnerTypes.js"

/** Shared phase window fields for synthetic and baseline-correlated collectors. */
export type SwapStressMetricWindow = {
  /** Phase whose window is being measured. */
  readonly phase: SwapStressPhase
  /** Inclusive phase start timestamp. */
  readonly startedAtMs: number
  /** Inclusive phase end timestamp. */
  readonly endedAtMs: number
  /** Direction expected to carry the phase envelopes. */
  readonly endpointsType: DebugOutpostEndpointsType
}

/** Baseline-free request accepted only by synthetic collectors. */
export type SwapStressSyntheticEnvelopeMetricRequest =
  SwapStressMetricWindow & {
    /** Synthetic collection cannot claim a real pre-phase baseline. */
    readonly baseline?: never
  }

/** Real metric request correlated to one caller-captured pre-phase baseline. */
export type SwapStressEnvelopeMetricRequest = SwapStressMetricWindow & {
  /** Exact all-key baseline captured before phase work begins. */
  readonly baseline: EnvelopeBaseline
}

/** Retryable generic telemetry that cannot claim flow saturation. */
export type SwapStressPendingPhaseObservation = OppPhaseEnvelopeMetrics & {
  /** Pending evidence is never terminal saturation evidence. */
  readonly saturated: false
  /** Empty and pending-publication are the only retryable collector states. */
  readonly health:
    EmptyOppEnvelopeTelemetryHealth | PendingOppEnvelopeTelemetryHealth
}

/** Exact structured causes that later deadline policy may terminalize. */
export type SwapStressTelemetryDegradation =
  | {
      /** Baseline discovery failed before phase work could be correlated. */
      readonly kind: "baseline_capture_failed"
      /** Ordered non-empty strict-reader issues returned by baseline capture. */
      readonly issues: EnvelopeIntegrityIssueSequence
    }
  | {
      /** Existing telemetry deadline expired with a retryable final observation. */
      readonly kind: "deadline_exhausted"
      /** Exact final pending observation retained for evidence. */
      readonly observation: SwapStressPendingPhaseObservation
    }

type SwapStressDeadlineTelemetryDegradation = Extract<
  SwapStressTelemetryDegradation,
  { readonly kind: "deadline_exhausted" }
>

/** Typed terminal error reserved for real telemetry integrity degradation. */
export class SwapStressTelemetryDegradedError<
  Degradation extends SwapStressTelemetryDegradation =
    SwapStressTelemetryDegradation
> extends Error {
  /** Stable runtime error identity. */
  readonly name = "SwapStressTelemetryDegradedError"
  /** Ramp/evidence category distinguishing telemetry integrity from infrastructure errors. */
  readonly category: "telemetry_integrity" = "telemetry_integrity"

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

/** Exhaustive canonical result of one real baseline-correlated collection. */
export type SwapStressEnvelopeMetricCollectionResult =
  | {
      /** Healthy generic telemetry projected into measured flow metrics. */
      readonly kind: "measured"
      /** Full measured metrics statically narrowed to healthy telemetry. */
      readonly metrics: SwapStressMeasuredPhaseEnvelopeMetrics & {
        readonly health: HealthyOppEnvelopeTelemetryHealth
      }
    }
  | {
      /** Retryable empty or incomplete publication retained as data. */
      readonly kind: "pending"
      /** Exact unsaturated generic observation. */
      readonly observation: SwapStressPendingPhaseObservation
    }
  | {
      /** Terminal degradation created only by later deadline policy. */
      readonly kind: "degraded"
      /** Typed error carrying the exact final pending deadline evidence. */
      readonly error: SwapStressTelemetryDegradedError<SwapStressDeadlineTelemetryDegradation>
    }

/** Optional synthetic phase metric collector. */
export type SwapStressSyntheticEnvelopeMetricCollector = (
  request: SwapStressSyntheticEnvelopeMetricRequest
) => Promise<SwapStressPhaseEnvelopeMetrics>

/** Required canonical real collector consuming a caller-provided baseline. */
export type SwapStressEnvelopeMetricCollector = (
  request: SwapStressEnvelopeMetricRequest
) => Promise<SwapStressEnvelopeMetricCollectionResult>

/** Required telemetry capabilities for real phase execution. */
export type SwapStressRealTelemetryDeps = {
  /** Real dependency discriminant. */
  readonly telemetryKind: "real"
  /** Capture the canonical OPP all-key baseline for one phase. */
  readonly captureEnvelopeBaseline: () => Promise<EnvelopeBaselineCaptureResult>
  /** Collect canonical phase metrics correlated to the supplied baseline. */
  readonly collectEnvelopeMetrics: SwapStressEnvelopeMetricCollector
}

/** Synthetic telemetry capabilities, which cannot capture or claim real baselines. */
export type SwapStressSyntheticTelemetryDeps = {
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
