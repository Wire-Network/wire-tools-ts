import type { EnvelopeIntegrityIssue } from "@wireio/debugging-shared"
import type {
  EmptyOppEnvelopeTelemetryHealth,
  OppPhaseEnvelopeMetrics,
  PendingOppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"
import {
  projectOppPhaseMetrics,
  SwapStressTelemetryDegradedError
} from "@wireio/test-flow-swap-stress-saturation"
import type {
  SwapStressEnvelopeMetricCollectionResult,
  SwapStressEnvelopeMetricRequest,
  SwapStressMeasuredPhaseEnvelopeMetrics,
  SwapStressPhaseEnvelopeMetrics,
  SwapStressRealTelemetryDeps,
  SwapStressSyntheticTelemetryDeps,
  SwapStressTelemetryDegradation
} from "@wireio/test-flow-swap-stress-saturation"

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false
type HasExactKeys<Source, Expected> = [keyof Source] extends [Expected]
  ? [Expected] extends [keyof Source]
    ? true
    : false
  : false
type ExplicitUndefined<Source, Key extends keyof Source> = Omit<Source, Key> & {
  readonly [Field in Key]: undefined
}
type DegradedResult = Extract<
  SwapStressEnvelopeMetricCollectionResult,
  { readonly kind: "degraded" }
>
type BaselineCaptureDegradation = Extract<
  SwapStressTelemetryDegradation,
  { readonly kind: "baseline_capture_failed" }
>
type BaselineCaptureError =
  SwapStressTelemetryDegradedError<BaselineCaptureDegradation>
type MeasuredCandidate<Health> = {
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
  readonly provenance: {
    readonly kind: "strict_snapshot"
    readonly solanaOversized: false
    readonly epochEnvelopeIndexes: readonly [0]
  }
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
  IsAssignable<
    {
      readonly telemetryKind: "synthetic"
      readonly captureEnvelopeBaseline: SwapStressRealTelemetryDeps["captureEnvelopeBaseline"]
    },
    SwapStressSyntheticTelemetryDeps
  >,
  IsAssignable<
    OppPhaseEnvelopeMetrics & {
      readonly health: PendingOppEnvelopeTelemetryHealth
    },
    Parameters<typeof projectOppPhaseMetrics>[0]
  >,
  IsAssignable<
    { readonly kind: "degraded"; readonly error: Error },
    DegradedResult
  >,
  IsAssignable<
    { readonly kind: "degraded"; readonly error: string },
    DegradedResult
  >,
  IsAssignable<
    {
      readonly kind: "degraded"
      readonly error: BaselineCaptureError
    },
    DegradedResult
  >,
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
  IsAssignable<
    {
      readonly kind: "baseline_capture_failed"
      readonly issue: EnvelopeIntegrityIssue
    },
    SwapStressTelemetryDegradation
  >,
  IsAssignable<
    {
      readonly kind: "baseline_capture_failed"
      readonly issues: readonly []
    },
    SwapStressTelemetryDegradation
  >,
  IsAssignable<
    {
      readonly kind: "deadline_exhausted"
      readonly observation: undefined
    },
    SwapStressTelemetryDegradation
  >,
  IsAssignable<
    { readonly kind: "degraded"; readonly error: undefined },
    DegradedResult
  >,
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
  HasExactKeys<
    SwapStressRealTelemetryDeps,
    "telemetryKind" | "captureEnvelopeBaseline" | "collectEnvelopeMetrics"
  >,
  HasExactKeys<
    SwapStressSyntheticTelemetryDeps,
    "telemetryKind" | "captureEnvelopeBaseline" | "collectEnvelopeMetrics"
  >,
  IsAssignable<
    SwapStressPhaseEnvelopeMetrics["measurement"],
    "measured" | "pending" | "unmeasured"
  >,
  IsAssignable<
    "measured" | "pending" | "unmeasured",
    SwapStressPhaseEnvelopeMetrics["measurement"]
  >,
  HasExactKeys<BaselineCaptureDegradation, "kind" | "issues">
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
