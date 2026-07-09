import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import type { BurstResult } from "./boundedBursts.js"
import type {
  SwapStressPhase,
  SwapStressPhaseEnvelopeMetrics,
  SwapStressPhaseResult
} from "./phaseRunnerTypes.js"

/**
 * Build an empty envelope-metrics record for a phase that did not saturate.
 *
 * @param phase Phase label to preserve in telemetry.
 * @param endpointsType Endpoint direction used for the phase.
 * @returns Zeroed metrics with a stable endpoint label.
 */
export function emptyMetrics(
  phase: string,
  endpointsType: DebugOutpostEndpointsType
): SwapStressPhaseEnvelopeMetrics {
  return {
    phase,
    saturated: false,
    envelopeCount: 0,
    envelopeByteSizes: [],
    endpoint: DebugOutpostEndpointsType[endpointsType],
    epochStart: 0,
    epochEnd: 0
  }
}

/**
 * Build the zero-value phase result used when a phase has no collected result.
 *
 * @param phase Phase label to preserve in the fallback record.
 * @returns Empty result payload for the supplied phase.
 */
export function emptyPhaseResult(phase: string): SwapStressPhaseResult {
  return {
    ...emptyMetrics(phase, DebugOutpostEndpointsType.UNKNOWN),
    txSuccesses: 0,
    txFailures: 0,
    startedAtMs: 0,
    endedAtMs: 0,
    payout: null
  }
}

/**
 * Format a burst failure reason for the supplied phase.
 *
 * @param phase Phase that failed to burst.
 * @param burst Burst result that carried the failure details.
 * @returns Joined burst failure message.
 */
export function burstReason(
  phase: SwapStressPhase,
  burst: BurstResult
): string {
  return `${phase} burst failed: ${burst.failures.map(failure => failure.reason).join("; ")}`
}

/**
 * Convert an unknown thrown value into a stable error message.
 *
 * @param error Thrown error-like value from the payout observer.
 * @returns Error message string suitable for classified breakage.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
