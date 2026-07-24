import type { BurstResult } from "./boundedBursts.js"
import type { SwapStressPhase } from "./phaseRunnerTypes.js"

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
