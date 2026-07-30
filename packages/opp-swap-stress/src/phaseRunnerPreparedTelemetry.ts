import { match } from "ts-pattern"

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
  type SwapStressMetricWindowIdentity,
  type SwapStressSyntheticEnvelopeMetricCollector,
  type SwapStressTelemetryDegradation,
  type SwapStressTelemetryDeps
} from "./phaseRunnerTelemetry.js"

/** `Extract` filter selecting the baseline-capture-failed degradation leg. */
interface BaselineCaptureDegradationDiscriminator {
  readonly kind: "baseline_capture_failed"
}

/** `Extract` filter selecting the deadline-exhausted degradation leg. */
interface DeadlineDegradationDiscriminator {
  readonly kind: "deadline_exhausted"
}

type BaselineCaptureDegradation = Extract<
  SwapStressTelemetryDegradation,
  BaselineCaptureDegradationDiscriminator
>
type DeadlineDegradation = Extract<
  SwapStressTelemetryDegradation,
  DeadlineDegradationDiscriminator
>

/** Prepared telemetry for a synthetic, baseline-free collection. */
interface PreparedSyntheticPhaseTelemetry {
  /** Synthetic collection remains baseline-free. */
  readonly telemetryKind: "synthetic"
  /** Optional synthetic collector represented explicitly when absent. */
  readonly collector: SwapStressSyntheticEnvelopeMetricCollector | null
}

/** Prepared telemetry for a real, baseline-correlated collection. */
interface PreparedRealPhaseTelemetry {
  /** Real collection requires one canonical pre-work baseline. */
  readonly telemetryKind: "real"
  /** Exact baseline object reused by every probe in the phase. */
  readonly baseline: EnvelopeBaseline
  /** Canonical real collector requiring the prepared baseline. */
  readonly collector: SwapStressEnvelopeMetricCollector
}

/** Phase telemetry prepared before payout or workload construction. */
export type PreparedPhaseTelemetry =
  | PreparedSyntheticPhaseTelemetry
  | PreparedRealPhaseTelemetry

/** One prepared phase collection plus any terminal typed degradation. */
export interface PreparedPhaseMetricCollection {
  /** Honest measured, pending, or unmeasured flow metrics. */
  readonly metrics: SwapStressPhaseEnvelopeMetrics
  /** Exact canonical terminal error, or null for nonterminal data. */
  readonly telemetryDegradation: SwapStressTelemetryDegradedError<DeadlineDegradation> | null
}

/** Preparation that produced a type-safe collector context. */
interface PreparedPhaseTelemetrySuccess {
  /** Preparation completed with a type-safe collector context. */
  readonly kind: "prepared"
  /** Baseline-free synthetic or baseline-bearing real telemetry. */
  readonly telemetry: PreparedPhaseTelemetry
}

/** Preparation terminalized by a failed baseline capture. */
interface PreparedPhaseTelemetryDegraded {
  /** Canonical baseline capture returned a structured failure. */
  readonly kind: "degraded"
  /** Exact typed failure created only from the returned capture issues. */
  readonly error: SwapStressTelemetryDegradedError<BaselineCaptureDegradation>
}

/** Exact outcome of preparing phase telemetry before workload construction. */
export type PreparedPhaseTelemetryResult =
  | PreparedPhaseTelemetrySuccess
  | PreparedPhaseTelemetryDegraded

/**
 * Prepare phase telemetry before any payout or workload side effect.
 * @param deps Real or synthetic phase-runner telemetry dependencies.
 * @param context Phase and endpoint whose evidence will be collected.
 * @returns Baseline-free synthetic context or captured real context.
 */
export async function preparePhaseTelemetry(
  deps: SwapStressTelemetryDeps,
  context: SwapStressMetricWindowIdentity
): Promise<PreparedPhaseTelemetryResult> {
  return match(deps)
    .with({ telemetryKind: "synthetic" }, syntheticDeps => ({
      kind: "prepared" as const,
      telemetry: {
        telemetryKind: "synthetic" as const,
        collector: syntheticDeps.collectEnvelopeMetrics ?? null
      }
    }))
    .with({ telemetryKind: "real" }, async realDeps => {
      const capture = await realDeps.captureEnvelopeBaseline()
      return match(capture)
        .with({ kind: "captured" }, captured => ({
          kind: "prepared" as const,
          telemetry: {
            telemetryKind: "real" as const,
            baseline: captured.baseline,
            collector: realDeps.collectEnvelopeMetrics
          }
        }))
        .with({ kind: "failed" }, failed => ({
          kind: "degraded" as const,
          error:
            new SwapStressTelemetryDegradedError<BaselineCaptureDegradation>(
              context.phase,
              context.endpointsType,
              { kind: "baseline_capture_failed", issues: failed.issues }
            )
        }))
        .otherwise(value => assertNeverBaselineCapture(value))
    })
    .otherwise(value => assertNeverTelemetryDeps(value))
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
  return match(prepared)
    .with({ telemetryKind: "synthetic" }, async syntheticPrepared => ({
      metrics:
        syntheticPrepared.collector === null
          ? emptyMetrics(
              window.phase,
              window.endpointsType,
              "collector_not_configured"
            )
          : await syntheticPrepared.collector(window),
      telemetryDegradation: null
    }))
    .with({ telemetryKind: "real" }, async realPrepared => {
      const result = await realPrepared.collector({
        ...window,
        baseline: realPrepared.baseline
      })
      return match(result)
        .with({ kind: "measured" }, measured => ({
          metrics: measured.metrics,
          telemetryDegradation: null
        }))
        .with({ kind: "pending" }, pending => ({
          metrics: projectPendingOppPhaseMetrics(pending.observation),
          telemetryDegradation: null
        }))
        .with({ kind: "degraded" }, degraded => ({
          metrics: degradedPhaseMetrics(degraded.error),
          telemetryDegradation: degraded.error
        }))
        .otherwise(value => assertNeverMetricCollection(value))
    })
    .otherwise(value => assertNeverPreparedTelemetry(value))
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
