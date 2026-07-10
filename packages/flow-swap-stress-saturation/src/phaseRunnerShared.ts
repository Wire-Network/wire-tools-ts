import type {
  SwapStressPhase,
  SwapStressPhaseRunnerDeps
} from "./phaseRunnerTypes.js"

/**
 * Select the minimum target amount used to avoid over-quoting a mixed batch.
 *
 * @param targetAmounts Quoted target amounts for one stress phase.
 * @returns Smallest target amount in the phase batch.
 */
export function minimumTargetAmount(targetAmounts: readonly bigint[]): bigint {
  return targetAmounts.reduce((minimum, targetAmount) =>
    targetAmount < minimum ? targetAmount : minimum
  )
}

/**
 * Run the optional batch-operator failure probe for a payout failure.
 *
 * @param deps Phase runner dependencies containing the optional probe.
 * @param phase Phase whose payout observer failed.
 * @param startedAtMs Phase start timestamp.
 * @param endedAtMs Failure observation timestamp.
 * @param payoutFailureReason Human-readable payout failure.
 * @returns Batch-operator failure reason when detected.
 */
export async function detectBatchOperatorFailure(
  deps: SwapStressPhaseRunnerDeps,
  phase: SwapStressPhase,
  startedAtMs: number,
  endedAtMs: number,
  payoutFailureReason: string
): Promise<string | null> {
  return deps.batchOperatorFailureProbe === undefined
    ? null
    : deps.batchOperatorFailureProbe({
        phase,
        startedAtMs,
        endedAtMs,
        payoutFailureReason
      })
}
