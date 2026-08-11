import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { runEthereumSwapBurst } from "./boundedBursts.js"
import {
  buildPayoutRequest,
  buildPhase1Requests
} from "./phaseRunnerRequests.js"
import { errorMessage, type PhaseRun } from "./phaseRunnerOutcomes.js"
import {
  collectPreparedPhaseMetrics,
  preparePhaseTelemetry
} from "./phaseRunnerPreparedTelemetry.js"
import { emptyMetrics, phaseResult } from "./phaseRunnerMetrics.js"
import type { StressIdentities } from "./stressIdentities.js"
import type { SwapStressPhaseRunnerDeps } from "./phaseRunnerTypes.js"
import {
  detectBatchOperatorFailure,
  minimumTargetAmount
} from "./phaseRunnerShared.js"

/**
 * Execute phase 1, Ethereum-to-WIRE swap stress work.
 *
 * @param deps Phase runner dependencies.
 * @param identities Stress account identities for the iteration.
 * @param targetAmounts Per-account target amounts.
 * @param clock Timestamp source.
 * @returns Phase 1 burst, metrics, payout, and failure telemetry.
 */
export async function runPhase1(
  deps: SwapStressPhaseRunnerDeps,
  identities: StressIdentities,
  targetAmounts: readonly bigint[],
  clock: () => number
): Promise<PhaseRun> {
  const phaseStartedAtMs = clock(),
    preparation = await preparePhaseTelemetry(deps, {
      phase: "phase-1",
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
    })
  if (preparation.kind === "degraded") {
    const phaseEndedAtMs = clock(),
      burst = { successes: [], failures: [] }
    return {
      burst,
      result: phaseResult(
        "phase-1",
        burst,
        null,
        emptyMetrics(
          "phase-1",
          DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
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
    targetAmount = minimumTargetAmount(targetAmounts),
    payoutRequest = buildPayoutRequest(
      "phase-1",
      identities.wire.map(identity => ({
        index: identity.index,
        address: identity.account
      })),
      targetAmount
    )
  await deps.recipientPayoutObserver.preparePayouts?.(payoutRequest)
  const phase1Requests = buildPhase1Requests(
      deps.route,
      identities,
      targetAmounts
    ),
    burst = await runEthereumSwapBurst({
      reserveManager: deps.ethereumReserveManager,
      requests: phase1Requests,
      firstNonce: await deps.getEthereumFirstNonce(phase1Requests.length),
      concurrency: deps.concurrency
    })
  const mainCollection = await collectPreparedPhaseMetrics(preparedTelemetry, {
    phase: "phase-1",
    startedAtMs: phaseStartedAtMs,
    endedAtMs: clock(),
    endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
  })
  if (mainCollection.telemetryDegradation !== null) {
    const endedAtMs = clock()
    return {
      burst,
      result: phaseResult(
        "phase-1",
        burst,
        null,
        mainCollection.metrics,
        phaseStartedAtMs,
        endedAtMs
      ),
      payoutFailureReason: null,
      batchOperatorFailureReason: null,
      telemetryDegradation: mainCollection.telemetryDegradation
    }
  }
  const metrics = mainCollection.metrics
  let payout: PhaseRun["result"]["payout"] = null,
    payoutFailureReason: string | null = null,
    batchOperatorFailureReason: string | null = null
  if (burst.failures.length === 0) {
    try {
      payout = await deps.recipientPayoutObserver.waitForPayouts(payoutRequest)
    } catch (error) {
      payoutFailureReason =
        error instanceof Error ? error.message : errorMessage(error)
      batchOperatorFailureReason = await detectBatchOperatorFailure(
        deps,
        "phase-1",
        phaseStartedAtMs,
        clock(),
        payoutFailureReason
      )
    }
  }
  if (payoutFailureReason !== null && !metrics.saturated) {
    const sourceCollection = await collectPreparedPhaseMetrics(
      preparedTelemetry,
      {
        phase: "phase-1",
        startedAtMs: phaseStartedAtMs,
        endedAtMs: clock(),
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
      }
    )
    if (sourceCollection.telemetryDegradation !== null) {
      const sourceEndedAtMs = clock()
      return {
        burst,
        result: phaseResult(
          "phase-1",
          burst,
          null,
          sourceCollection.metrics,
          phaseStartedAtMs,
          sourceEndedAtMs
        ),
        payoutFailureReason,
        batchOperatorFailureReason,
        telemetryDegradation: sourceCollection.telemetryDegradation
      }
    }
    const sourceMetrics = sourceCollection.metrics
    if (sourceMetrics.saturated) {
      const sourceEndedAtMs = clock()
      return {
        burst,
        result: phaseResult(
          "phase-1",
          burst,
          null,
          sourceMetrics,
          phaseStartedAtMs,
          sourceEndedAtMs
        ),
        payoutFailureReason,
        batchOperatorFailureReason,
        telemetryDegradation: null
      }
    }
    const destinationCollection = await collectPreparedPhaseMetrics(
      preparedTelemetry,
      {
        phase: "phase-1",
        startedAtMs: phaseStartedAtMs,
        endedAtMs: clock(),
        endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
      }
    )
    if (destinationCollection.telemetryDegradation !== null) {
      const destinationEndedAtMs = clock()
      return {
        burst,
        result: phaseResult(
          "phase-1",
          burst,
          null,
          destinationCollection.metrics,
          phaseStartedAtMs,
          destinationEndedAtMs
        ),
        payoutFailureReason,
        batchOperatorFailureReason,
        telemetryDegradation: destinationCollection.telemetryDegradation
      }
    }
    const destinationMetrics = destinationCollection.metrics
    if (destinationMetrics.saturated) {
      const destinationEndedAtMs = clock()
      return {
        burst,
        result: phaseResult(
          "phase-1",
          burst,
          null,
          destinationMetrics,
          phaseStartedAtMs,
          destinationEndedAtMs
        ),
        payoutFailureReason,
        batchOperatorFailureReason,
        telemetryDegradation: null
      }
    }
  }
  const endedAtMs = clock()
  return {
    burst,
    result: phaseResult(
      "phase-1",
      burst,
      payout,
      metrics,
      phaseStartedAtMs,
      endedAtMs
    ),
    payoutFailureReason,
    batchOperatorFailureReason,
    telemetryDegradation: null
  }
}
