import type { EnvelopeBaselineCaptureResult } from "@wireio/debugging-shared"

import type {
  SwapStressEnvelopeMetricCollectionResult,
  SwapStressEnvelopeMetricRequest
} from "./phaseRunnerTelemetry.js"
import { SwapStressTelemetryDegradedError } from "./phaseRunnerTelemetry.js"

type RealMetricSnapshotResult = Exclude<
  SwapStressEnvelopeMetricCollectionResult,
  { readonly kind: "degraded" }
>

/** Fixed real-flow strict metric polling policy. */
export namespace RealFlowMetricPolling {
  /** Deadline for strict telemetry repair; changing it alters terminal evidence timing. */
  export const RelayDeadlineMs = 240_000
  /** Gap between strict snapshots; changing it alters real-flow OPP scan cadence. */
  export const LongPollIntervalMs = 3_000
}

/** Clock, wait, and one-shot strict collector used by real metric polling. */
export type RealMetricPollingRuntime = {
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
export type RealBaselinePollingRuntime = {
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
    switch (result.kind) {
      case "captured":
        return result
      case "failed": {
        const remainingMs = deadlineAtMs - runtime.now()
        if (remainingMs <= 0) return result
        await runtime.wait(
          Math.min(RealFlowMetricPolling.LongPollIntervalMs, remainingMs)
        )
        if (runtime.now() >= deadlineAtMs) return result
        result = await runtime.capture()
        break
      }
      default:
        return assertNeverBaselineCapture(result)
    }
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
    switch (result.kind) {
      case "measured":
        return result
      case "pending": {
        const remainingMs = deadlineAtMs - runtime.now()
        if (remainingMs <= 0) return terminalResult(request, result.observation)
        await runtime.wait(
          Math.min(RealFlowMetricPolling.LongPollIntervalMs, remainingMs)
        )
        if (runtime.now() >= deadlineAtMs)
          return terminalResult(request, result.observation)
        result = await runtime.collect(request)
        break
      }
      default:
        return assertNever(result)
    }
  }
}

function terminalResult(
  request: SwapStressEnvelopeMetricRequest,
  observation: Extract<RealMetricSnapshotResult, { readonly kind: "pending" }>[
    "observation"
  ]
): Extract<
  SwapStressEnvelopeMetricCollectionResult,
  { readonly kind: "degraded" }
> {
  return {
    kind: "degraded",
    error: new SwapStressTelemetryDegradedError(
      request.phase,
      request.endpointsType,
      { kind: "deadline_exhausted", observation }
    )
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected real metric snapshot: ${String(value)}`)
}

function assertNeverBaselineCapture(value: never): never {
  throw new TypeError(`Unexpected real baseline capture: ${String(value)}`)
}
