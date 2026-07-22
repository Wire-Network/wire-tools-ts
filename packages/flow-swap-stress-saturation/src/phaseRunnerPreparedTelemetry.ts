import type { EnvelopeBaseline } from "@wireio/debugging-shared"
import type { SwapStressPhaseEnvelopeMetrics } from "./phaseRunnerMetricTypes.js"
import {
  emptyMetrics,
  projectPendingOppPhaseMetrics
} from "./phaseRunnerMetrics.js"
import {
  SwapStressTelemetryDegradedError,
  type SwapStressEnvelopeMetricCollector,
  type SwapStressMetricWindow,
  type SwapStressSyntheticEnvelopeMetricCollector,
  type SwapStressTelemetryDegradation,
  type SwapStressTelemetryDeps
} from "./phaseRunnerTelemetry.js"

type BaselineCaptureDegradation = Extract<
  SwapStressTelemetryDegradation,
  { readonly kind: "baseline_capture_failed" }
>
type DeadlineDegradation = Extract<
  SwapStressTelemetryDegradation,
  { readonly kind: "deadline_exhausted" }
>

/** Phase telemetry prepared before payout or workload construction. */
export type PreparedPhaseTelemetry =
  | {
      /** Synthetic collection remains baseline-free. */
      readonly telemetryKind: "synthetic"
      /** Optional synthetic collector represented explicitly when absent. */
      readonly collector: SwapStressSyntheticEnvelopeMetricCollector | null
    }
  | {
      /** Real collection requires one canonical pre-work baseline. */
      readonly telemetryKind: "real"
      /** Exact baseline object reused by every probe in the phase. */
      readonly baseline: EnvelopeBaseline
      /** Canonical real collector requiring the prepared baseline. */
      readonly collector: SwapStressEnvelopeMetricCollector
    }

/** One prepared phase collection plus any terminal typed degradation. */
export type PreparedPhaseMetricCollection = {
  /** Honest measured, pending, or unmeasured flow metrics. */
  readonly metrics: SwapStressPhaseEnvelopeMetrics
  /** Exact canonical terminal error, or null for nonterminal data. */
  readonly telemetryDegradation: SwapStressTelemetryDegradedError<DeadlineDegradation> | null
}

/** Exact outcome of preparing phase telemetry before workload construction. */
export type PreparedPhaseTelemetryResult =
  | {
      /** Preparation completed with a type-safe collector context. */
      readonly kind: "prepared"
      /** Baseline-free synthetic or baseline-bearing real telemetry. */
      readonly telemetry: PreparedPhaseTelemetry
    }
  | {
      /** Canonical baseline capture returned a structured failure. */
      readonly kind: "degraded"
      /** Exact typed failure created only from the returned capture issues. */
      readonly error: SwapStressTelemetryDegradedError<BaselineCaptureDegradation>
    }

/**
 * Prepare phase telemetry before any payout or workload side effect.
 * @param deps Real or synthetic phase-runner telemetry dependencies.
 * @param context Phase and endpoint whose evidence will be collected.
 * @returns Baseline-free synthetic context or captured real context.
 */
export async function preparePhaseTelemetry(
  deps: SwapStressTelemetryDeps,
  context: Pick<SwapStressMetricWindow, "phase" | "endpointsType">
): Promise<PreparedPhaseTelemetryResult> {
  switch (deps.telemetryKind) {
    case "synthetic":
      return {
        kind: "prepared",
        telemetry: {
          telemetryKind: "synthetic",
          collector: deps.collectEnvelopeMetrics ?? null
        }
      }
    case "real": {
      const capture = await deps.captureEnvelopeBaseline()
      switch (capture.kind) {
        case "captured":
          return {
            kind: "prepared",
            telemetry: {
              telemetryKind: "real",
              baseline: capture.baseline,
              collector: deps.collectEnvelopeMetrics
            }
          }
        case "failed":
          return {
            kind: "degraded",
            error:
              new SwapStressTelemetryDegradedError<BaselineCaptureDegradation>(
                context.phase,
                context.endpointsType,
                { kind: "baseline_capture_failed", issues: capture.issues }
              )
          }
        default:
          return assertNeverBaselineCapture(capture)
      }
    }
    default:
      return assertNeverTelemetryDeps(deps)
  }
}

/**
 * Collect one probe through its already-prepared telemetry context.
 * @param prepared Baseline-free synthetic or baseline-bearing real context.
 * @param window Exact phase observation window and endpoint.
 * @returns Honest metrics plus a typed terminal degradation when present.
 */
export async function collectPreparedPhaseMetrics(
  prepared: PreparedPhaseTelemetry,
  window: SwapStressMetricWindow
): Promise<PreparedPhaseMetricCollection> {
  switch (prepared.telemetryKind) {
    case "synthetic":
      return {
        metrics:
          prepared.collector === null
            ? emptyMetrics(
                window.phase,
                window.endpointsType,
                "collector_not_configured"
              )
            : await prepared.collector(window),
        telemetryDegradation: null
      }
    case "real": {
      const result = await prepared.collector({
        ...window,
        baseline: prepared.baseline
      })
      switch (result.kind) {
        case "measured":
          return { metrics: result.metrics, telemetryDegradation: null }
        case "pending":
          return {
            metrics: projectPendingOppPhaseMetrics(result.observation),
            telemetryDegradation: null
          }
        case "degraded":
          return {
            metrics: degradedPhaseMetrics(result.error),
            telemetryDegradation: result.error
          }
        default:
          return assertNeverMetricCollection(result)
      }
    }
    default:
      return assertNeverPreparedTelemetry(prepared)
  }
}

function degradedPhaseMetrics(
  error: SwapStressTelemetryDegradedError<DeadlineDegradation>
): SwapStressPhaseEnvelopeMetrics {
  return projectPendingOppPhaseMetrics(error.degradation.observation)
}

function assertNeverTelemetryDeps(value: never): never {
  throw new TypeError(`Unexpected telemetry dependencies: ${String(value)}`)
}

function assertNeverBaselineCapture(value: never): never {
  throw new TypeError(`Unexpected baseline capture result: ${String(value)}`)
}

function assertNeverMetricCollection(value: never): never {
  throw new TypeError(`Unexpected metric collection result: ${String(value)}`)
}

function assertNeverPreparedTelemetry(value: never): never {
  throw new TypeError(`Unexpected prepared telemetry: ${String(value)}`)
}
