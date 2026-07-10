import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { runSolanaSwapBurst } from "./boundedBursts.js"
import {
  buildPayoutRequest,
  buildPhase2Requests
} from "./phaseRunnerRequests.js"
import {
  collectMetrics,
  errorMessage,
  phaseResult,
  type PhaseRun
} from "./phaseRunnerOutcomes.js"
import { emptyMetrics } from "./phaseRunnerFallbacks.js"
import type { StressIdentities } from "./stressIdentities.js"
import {
  SwapStressPhaseAmounts,
  type SwapStressPhaseRunnerDeps
} from "./phaseRunnerTypes.js"
import {
  detectBatchOperatorFailure,
  minimumTargetAmount
} from "./phaseRunnerShared.js"

/** Phase 2 result with optional metrics failure classification. */
export type Phase2Run = PhaseRun & {
  readonly metricsFailureReason: string | null
}

const MetricsTimeoutPrefix = "Timed out waiting for:"

/**
 * Execute phase 2, WIRE/Solana-to-Ethereum return swap stress work.
 *
 * @param deps Phase runner dependencies.
 * @param identities Stress account identities for the iteration.
 * @param targetAmounts Per-account target amounts.
 * @param clock Timestamp source.
 * @returns Phase 2 burst, metrics, payout, and failure telemetry.
 */
export async function runPhase2(
  deps: SwapStressPhaseRunnerDeps,
  identities: StressIdentities,
  targetAmounts: readonly bigint[],
  clock: () => number
): Promise<Phase2Run> {
  const phaseStartedAtMs = clock(),
    targetWei =
      minimumTargetAmount(targetAmounts) *
      SwapStressPhaseAmounts.EthWeiPerDepotUnit,
    payoutRequest = buildPayoutRequest(
      "phase-2",
      identities.ethereum.map(identity => ({
        index: identity.index,
        address: identity.address
      })),
      targetWei
    )
  await deps.returnPayoutObserver.preparePayouts?.(payoutRequest)
  const burst = await runSolanaSwapBurst({
    requests: buildPhase2Requests(deps.route, identities, targetAmounts),
    concurrency: deps.concurrency,
    submit: deps.submitPhase2Swap
  })
  let payout: PhaseRun["result"]["payout"] = null,
    payoutFailureReason: string | null = null,
    batchOperatorFailureReason: string | null = null
  if (burst.failures.length === 0) {
    try {
      payout = await deps.returnPayoutObserver.waitForPayouts(payoutRequest)
    } catch (error) {
      payoutFailureReason =
        error instanceof Error ? error.message : errorMessage(error)
      batchOperatorFailureReason = await detectBatchOperatorFailure(
        deps,
        "phase-2",
        phaseStartedAtMs,
        clock(),
        payoutFailureReason
      )
    }
  }
  const endedAtMs = clock()
  let metrics = emptyMetrics(
      "phase-2",
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    ),
    metricsFailureReason: string | null = null
  try {
    metrics = await collectMetrics(
      deps,
      "phase-2",
      phaseStartedAtMs,
      endedAtMs
    )
  } catch (error) {
    const message = errorMessage(error)
    if (!message.startsWith(MetricsTimeoutPrefix)) throw error
    metricsFailureReason = message
  }
  return {
    burst,
    result: phaseResult(
      "phase-2",
      burst,
      payout,
      metrics,
      phaseStartedAtMs,
      endedAtMs
    ),
    payoutFailureReason,
    batchOperatorFailureReason,
    metricsFailureReason
  }
}
