import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { runSolanaSwapBurst } from "./boundedBursts.js"
import {
  buildPayoutRequest,
  buildPhase2Requests
} from "./phaseRunnerRequests.js"
import { errorMessage, type PhaseRun } from "./phaseRunnerOutcomes.js"
import {
  collectPreparedPhaseMetrics,
  preparePhaseTelemetry
} from "./phaseRunnerPreparedTelemetry.js"
import { emptyMetrics, phaseResult } from "./phaseRunnerMetrics.js"
import type { StressIdentities } from "./stressIdentities.js"
import {
  SwapStressPhaseAmounts,
  type SwapStressPhaseRunnerDeps
} from "./phaseRunnerTypes.js"
import {
  detectBatchOperatorFailure,
  minimumTargetAmount
} from "./phaseRunnerShared.js"

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
): Promise<PhaseRun> {
  const phaseStartedAtMs = clock(),
    preparation = await preparePhaseTelemetry(deps, {
      phase: "phase-2",
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    })
  if (preparation.kind === "degraded") {
    const phaseEndedAtMs = clock(),
      burst = { successes: [], failures: [] }
    return {
      burst,
      result: phaseResult(
        "phase-2",
        burst,
        null,
        emptyMetrics(
          "phase-2",
          DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
          "collection_failed"
        ),
        phaseStartedAtMs,
        phaseEndedAtMs
      ),
      payoutFailureReason: null,
      batchOperatorFailureReason: null,
      telemetryDegradation: preparation.error
    }
  }
  const preparedTelemetry = preparation.telemetry,
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
  const endedAtMs = clock(),
    collection = await collectPreparedPhaseMetrics(preparedTelemetry, {
      phase: "phase-2",
      startedAtMs: phaseStartedAtMs,
      endedAtMs,
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    })
  return {
    burst,
    result: phaseResult(
      "phase-2",
      burst,
      payout,
      collection.metrics,
      phaseStartedAtMs,
      endedAtMs
    ),
    payoutFailureReason,
    batchOperatorFailureReason,
    telemetryDegradation: collection.telemetryDegradation
  }
}
