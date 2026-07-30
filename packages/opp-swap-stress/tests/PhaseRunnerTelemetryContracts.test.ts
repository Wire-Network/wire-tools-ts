import type { EnvelopeIntegrityIssue } from "@wireio/debugging-shared"
import type {
  EmptyOppEnvelopeTelemetryHealth,
  OppPhaseEnvelopeMetrics,
  PendingOppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"
import {
  projectOppPhaseMetrics,
  SwapStressTelemetryDegradedError
} from "@wireio/opp-swap-stress"
import type {
  SwapStressEnvelopeMetricCollectionResult,
  SwapStressEnvelopeMetricRequest,
  SwapStressMeasuredPhaseEnvelopeMetrics,
  SwapStressPhaseEnvelopeMetrics,
  SwapStressRealTelemetryDeps,
  SwapStressSyntheticTelemetryDeps,
  SwapStressTelemetryDegradation
} from "@wireio/opp-swap-stress"

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false
type HasExactKeys<Source, Expected> = [keyof Source] extends [Expected]
  ? [Expected] extends [keyof Source]
    ? true
    : false
  : false
type ExplicitUndefined<Source, Key extends keyof Source> = Omit<Source, Key> & {
  readonly [Field in Key]: undefined
}
/** `Extract` filter selecting the degraded collection leg. */
interface DegradedResultDiscriminator {
  readonly kind: "degraded"
}

/** `Extract` filter selecting the baseline-capture-failed degradation leg. */
interface BaselineCaptureDiscriminator {
  readonly kind: "baseline_capture_failed"
}

type DegradedResult = Extract<
  SwapStressEnvelopeMetricCollectionResult,
  DegradedResultDiscriminator
>
type BaselineCaptureDegradation = Extract<
  SwapStressTelemetryDegradation,
  BaselineCaptureDiscriminator
>
type BaselineCaptureError =
  SwapStressTelemetryDegradedError<BaselineCaptureDegradation>

/** Strict-snapshot provenance a measured candidate carries. */
interface MeasuredCandidateProvenance {
  readonly kind: "strict_snapshot"
  readonly solanaOversized: false
  readonly epochEnvelopeIndexes: readonly [0]
}

interface MeasuredCandidate<Health> {
  readonly measurement: "measured"
  readonly phase: "phase-1"
  readonly saturated: true
  readonly envelopeCount: 1
  readonly envelopeByteSizes: readonly [256]
  readonly endpoint: "OUTPOST_ETHEREUM_DEPOT"
  readonly epochStart: 7
  readonly epochEnd: 8
  readonly health: Health
  readonly malformedRecords: readonly []
  readonly artifactRefs: readonly []
  readonly provenance: MeasuredCandidateProvenance
}

/** Synthetic deps illegally carrying the real capture hook. */
interface SyntheticDepsWithCapture {
  readonly telemetryKind: "synthetic"
  readonly captureEnvelopeBaseline: SwapStressRealTelemetryDeps["captureEnvelopeBaseline"]
}

/** The retryable-health narrowing a projection input must NOT accept. */
interface PendingHealthNarrowing {
  readonly health: PendingOppEnvelopeTelemetryHealth
}

/** Degraded shape whose error is a bare `Error`. */
interface DegradedWithBareError {
  readonly kind: "degraded"
  readonly error: Error
}

/** Degraded shape whose error is a string. */
interface DegradedWithStringError {
  readonly kind: "degraded"
  readonly error: string
}

/** Degraded shape whose error is the baseline-capture-typed error. */
interface DegradedWithBaselineCaptureError {
  readonly kind: "degraded"
  readonly error: BaselineCaptureError
}

/** Degraded shape whose error is absent. */
interface DegradedWithUndefinedError {
  readonly kind: "degraded"
  readonly error: undefined
}

/** Baseline-capture degradation carrying a single issue instead of a sequence. */
interface BaselineCaptureWithSingleIssue {
  readonly kind: "baseline_capture_failed"
  readonly issue: EnvelopeIntegrityIssue
}

/** Baseline-capture degradation carrying an empty issue sequence. */
interface BaselineCaptureWithNoIssues {
  readonly kind: "baseline_capture_failed"
  readonly issues: readonly []
}

/** Deadline degradation carrying no final observation. */
interface DeadlineWithUndefinedObservation {
  readonly kind: "deadline_exhausted"
  readonly observation: undefined
}

/**
 * The exact key set the telemetry deps surfaces pin. Declared as an interface
 * so each proof's key union is DERIVED (`keyof`) rather than re-spelled.
 */
interface TelemetryDepsSurfaceKeys {
  readonly telemetryKind: never
  readonly captureEnvelopeBaseline: never
  readonly collectEnvelopeMetrics: never
}

/** The exact key set a baseline-capture degradation pins. */
interface BaselineCaptureDegradationKeys {
  readonly kind: never
  readonly issues: never
}

/** The measurement discriminants the phase-metrics union pins. */
enum ExpectedMeasurementKind {
  measured = "measured",
  pending = "pending",
  unmeasured = "unmeasured"
}
const contractProofs: readonly [
  IsAssignable<
    Omit<SwapStressRealTelemetryDeps, "captureEnvelopeBaseline">,
    SwapStressRealTelemetryDeps
  >,
  IsAssignable<
    Omit<SwapStressRealTelemetryDeps, "collectEnvelopeMetrics">,
    SwapStressRealTelemetryDeps
  >,
  IsAssignable<
    Omit<SwapStressEnvelopeMetricRequest, "baseline">,
    SwapStressEnvelopeMetricRequest
  >,
  IsAssignable<SyntheticDepsWithCapture, SwapStressSyntheticTelemetryDeps>,
  IsAssignable<
    OppPhaseEnvelopeMetrics & PendingHealthNarrowing,
    Parameters<typeof projectOppPhaseMetrics>[0]
  >,
  IsAssignable<DegradedWithBareError, DegradedResult>,
  IsAssignable<DegradedWithStringError, DegradedResult>,
  IsAssignable<DegradedWithBaselineCaptureError, DegradedResult>,
  IsAssignable<
    ExplicitUndefined<SwapStressEnvelopeMetricRequest, "baseline">,
    SwapStressEnvelopeMetricRequest
  >,
  IsAssignable<
    ExplicitUndefined<SwapStressRealTelemetryDeps, "captureEnvelopeBaseline">,
    SwapStressRealTelemetryDeps
  >,
  IsAssignable<
    ExplicitUndefined<SwapStressRealTelemetryDeps, "collectEnvelopeMetrics">,
    SwapStressRealTelemetryDeps
  >,
  IsAssignable<undefined, SwapStressTelemetryDegradation>,
  IsAssignable<
    undefined,
    ConstructorParameters<typeof SwapStressTelemetryDegradedError>[2]
  >,
  IsAssignable<BaselineCaptureWithSingleIssue, SwapStressTelemetryDegradation>,
  IsAssignable<BaselineCaptureWithNoIssues, SwapStressTelemetryDegradation>,
  IsAssignable<
    DeadlineWithUndefinedObservation,
    SwapStressTelemetryDegradation
  >,
  IsAssignable<DegradedWithUndefinedError, DegradedResult>,
  IsAssignable<
    MeasuredCandidate<EmptyOppEnvelopeTelemetryHealth>,
    SwapStressMeasuredPhaseEnvelopeMetrics
  >,
  IsAssignable<
    MeasuredCandidate<PendingOppEnvelopeTelemetryHealth>,
    SwapStressMeasuredPhaseEnvelopeMetrics
  >
] = [
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false,
  false
]

const exactSurfaceProofs: readonly [
  HasExactKeys<SwapStressRealTelemetryDeps, keyof TelemetryDepsSurfaceKeys>,
  HasExactKeys<
    SwapStressSyntheticTelemetryDeps,
    keyof TelemetryDepsSurfaceKeys
  >,
  IsAssignable<
    SwapStressPhaseEnvelopeMetrics["measurement"],
    `${ExpectedMeasurementKind}`
  >,
  IsAssignable<
    `${ExpectedMeasurementKind}`,
    SwapStressPhaseEnvelopeMetrics["measurement"]
  >,
  HasExactKeys<BaselineCaptureDegradation, keyof BaselineCaptureDegradationKeys>
] = [true, true, true, true, true]

describe("phase runner telemetry compiler contracts", () => {
  it("keeps omitted and explicitly undefined values outside the public contract", () => {
    // Given / When / Then: every negative assignability proof compiles as false.
    expect(contractProofs).toEqual(Array(contractProofs.length).fill(false))
  })

  it("requires only canonical real dependencies and the three honest metric outcomes", () => {
    // Given / When / Then: exact key and measurement unions compile without compatibility members.
    expect(exactSurfaceProofs).toEqual([true, true, true, true, true])
  })
})
