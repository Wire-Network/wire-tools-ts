import { match } from "ts-pattern"

import type { EnvelopeBaselineCaptureResult } from "../envelope-integrity/index.js"

import type {
  SwapStressDegradedCollectionResult,
  SwapStressEnvelopeMetricCollectionResult,
  SwapStressEnvelopeMetricRequest,
  SwapStressPendingPhaseObservation
} from "./phaseRunnerTelemetry.js"
import { SwapStressTelemetryDegradedError } from "./phaseRunnerTelemetry.js"

type RealMetricSnapshotResult = Exclude<
  SwapStressEnvelopeMetricCollectionResult,
  SwapStressDegradedCollectionResult
>

/** Fixed real-flow strict metric polling policy. */
export namespace RealFlowMetricPolling {
  /** Deadline for strict telemetry repair; changing it alters terminal evidence timing. */
  export const RelayDeadlineMs = 240_000
  /** Gap between strict snapshots; changing it alters real-flow OPP scan cadence. */
  export const LongPollIntervalMs = 3_000
}

/** Clock, wait, and one-shot strict collector used by real metric polling. */
export interface RealMetricPollingRuntime {
  /** Return the current monotonic policy time in milliseconds. */
  readonly now: () => number
  /** Advance or await policy time without owning a timeout configuration. */
  readonly wait: (milliseconds: number) => Promise<void>
  /** Collect one strict snapshot correlated to the supplied phase baseline. */
  readonly collect: (
    request: SwapStressEnvelopeMetricRequest
  ) => Promise<RealMetricSnapshotResult>
}

/** Clock, wait, and one-shot strict capture used by real baseline polling. */
export interface RealBaselinePollingRuntime {
  /** Return the current monotonic policy time in milliseconds. */
  readonly now: () => number
  /** Advance or await policy time without owning a timeout configuration. */
  readonly wait: (milliseconds: number) => Promise<void>
  /** Capture one strict all-key baseline snapshot. */
  readonly capture: () => Promise<EnvelopeBaselineCaptureResult>
}

/**
 * Poll strict real-flow baseline capture until captured or the fixed relay deadline.
 *
 * @param runtime Injected clock, wait, and one-shot strict baseline capture.
 * @returns The captured baseline or exact final failed capture result.
 */
export async function pollRealFlowBaseline(
  runtime: RealBaselinePollingRuntime
): Promise<EnvelopeBaselineCaptureResult> {
  const deadlineAtMs = runtime.now() + RealFlowMetricPolling.RelayDeadlineMs
  let result = await runtime.capture()

  while (true) {
    // `null` means "keep polling"; a `settled` wrapper carries the terminal result.
    const outcome = await match(result)
      .with({ kind: "captured" }, captured => ({ settled: captured }))
      .with({ kind: "failed" }, async failed => {
        const remainingMs = deadlineAtMs - runtime.now()
        if (remainingMs <= 0) return { settled: failed }
        await runtime.wait(
          Math.min(RealFlowMetricPolling.LongPollIntervalMs, remainingMs)
        )
        if (runtime.now() >= deadlineAtMs) return { settled: failed }
        result = await runtime.capture()
        return null
      })
      .exhaustive()
    if (outcome !== null) return outcome.settled
  }
}

/**
 * Poll strict real-flow metrics until healthy or the fixed relay deadline.
 *
 * @param request Baseline-correlated phase request reused for every snapshot.
 * @param runtime Injected clock, wait, and one-shot strict collector.
 * @returns Healthy measured evidence or typed degradation retaining the final snapshot.
 */
export async function pollRealFlowMetrics(
  request: SwapStressEnvelopeMetricRequest,
  runtime: RealMetricPollingRuntime
): Promise<SwapStressEnvelopeMetricCollectionResult> {
  const deadlineAtMs = runtime.now() + RealFlowMetricPolling.RelayDeadlineMs
  let result = await runtime.collect(request)

  while (true) {
    // `null` means "keep polling"; a `settled` wrapper carries the terminal result.
    const outcome = await match(result)
      .with({ kind: "measured" }, measured => ({ settled: measured }))
      .with({ kind: "pending" }, async pending => {
        const remainingMs = deadlineAtMs - runtime.now()
        if (remainingMs <= 0)
          return { settled: terminalResult(request, pending.observation) }
        await runtime.wait(
          Math.min(RealFlowMetricPolling.LongPollIntervalMs, remainingMs)
        )
        if (runtime.now() >= deadlineAtMs)
          return { settled: terminalResult(request, pending.observation) }
        result = await runtime.collect(request)
        return null
      })
      .exhaustive()
    if (outcome !== null) return outcome.settled
  }
}

function terminalResult(
  request: SwapStressEnvelopeMetricRequest,
  observation: SwapStressPendingPhaseObservation
): SwapStressDegradedCollectionResult {
  return {
    kind: "degraded",
    error: new SwapStressTelemetryDegradedError(
      request.phase,
      request.endpointsType,
      { kind: "deadline_exhausted", observation }
    )
  }
}


