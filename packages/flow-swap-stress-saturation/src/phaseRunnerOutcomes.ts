import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import type { BurstResult } from "./boundedBursts.js"
import type { StressRampIterationOutcome } from "./rampController.js"
import { classifyEthereumAllLegsSaturation } from "./ethereumAllLegsClassification.js"
import type {
  SwapStressIterationOutcome,
  SwapStressPhase,
  SwapStressPhaseEnvelopeMetrics,
  SwapStressPhaseResult,
  SwapStressPayoutObservation
} from "./phaseRunnerTypes.js"
import { emptyMetrics, emptyPhaseResult } from "./phaseRunnerFallbacks.js"

export { burstReason, errorMessage } from "./phaseRunnerFallbacks.js"

export type PhaseRun = {
  readonly burst: BurstResult
  readonly result: SwapStressPhaseResult
  readonly payoutFailureReason: string | null
  readonly batchOperatorFailureReason: string | null
}

export async function collectMetrics(
  deps: {
    readonly collectEnvelopeMetrics?: (request: {
      readonly phase: SwapStressPhase
      readonly startedAtMs: number
      readonly endedAtMs: number
      readonly endpointsType: DebugOutpostEndpointsType
    }) => Promise<SwapStressPhaseEnvelopeMetrics>
  },
  phase: SwapStressPhase,
  startedAtMs: number,
  endedAtMs: number,
  endpointsTypeOverride?: DebugOutpostEndpointsType
): Promise<SwapStressPhaseEnvelopeMetrics> {
  const endpointsType =
    endpointsTypeOverride ??
    (phase === "phase-1"
      ? DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
      : DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM)
  return deps.collectEnvelopeMetrics === undefined
    ? emptyMetrics(phase, endpointsType)
    : deps.collectEnvelopeMetrics({
        phase,
        startedAtMs,
        endedAtMs,
        endpointsType
      })
}

export function phaseResult(
  phase: SwapStressPhase,
  burst: BurstResult,
  payout: SwapStressPayoutObservation | null,
  metrics: SwapStressPhaseEnvelopeMetrics,
  startedAtMs: number,
  endedAtMs: number
): SwapStressPhaseResult {
  return {
    ...metrics,
    phase,
    startedAtMs,
    endedAtMs,
    txSuccesses: burst.successes.length,
    txFailures: burst.failures.length,
    payout
  }
}

export function complete(
  count: number,
  startedAtMs: number,
  endedAtMs: number,
  phaseResults: readonly SwapStressPhaseResult[]
): SwapStressIterationOutcome {
  const classification = classifyEthereumAllLegsSaturation(phaseResults),
    finalPhase =
      phaseResults.find(
        result =>
          result.saturated &&
          classification.saturatedEndpoints.some(
            endpoint => result.endpoint === DebugOutpostEndpointsType[endpoint]
          )
      ) ??
      phaseResults[phaseResults.length - 1] ??
      emptyPhaseResult("phase-2")
  return outcome(
    count,
    classification.status === "saturated" ? "saturated" : "not_saturated",
    finalPhase,
    startedAtMs,
    endedAtMs,
    phaseResults
  )
}

export function breakage(
  count: number,
  phase: string,
  startedAtMs: number,
  endedAtMs: number,
  phaseResultOrResults:
    SwapStressPhaseResult | readonly SwapStressPhaseResult[],
  reason: string
): SwapStressIterationOutcome {
  const phaseResults = Array.isArray(phaseResultOrResults)
      ? phaseResultOrResults
      : [phaseResultOrResults],
    finalPhase =
      phaseResults[phaseResults.length - 1] ?? emptyPhaseResult(phase)
  return {
    ...outcome(
      count,
      "breakage",
      finalPhase,
      startedAtMs,
      endedAtMs,
      phaseResults
    ),
    phase,
    breakageReason: reason
  }
}

function outcome(
  count: number,
  kind: StressRampIterationOutcome["kind"],
  finalPhase: SwapStressPhaseResult,
  startedAtMs: number,
  endedAtMs: number,
  phaseResults: readonly SwapStressPhaseResult[]
): SwapStressIterationOutcome {
  const classification = classifyEthereumAllLegsSaturation(phaseResults)
  return {
    kind,
    iterationIndex: 0,
    accountCount: count,
    phase: finalPhase.phase,
    startedAtMs,
    endedAtMs,
    txSuccesses: phaseResults.reduce(
      (total, result) => total + result.txSuccesses,
      0
    ),
    txFailures: phaseResults.reduce(
      (total, result) => total + result.txFailures,
      0
    ),
    envelopeCount: finalPhase.envelopeCount,
    envelopeByteSizes: finalPhase.envelopeByteSizes,
    endpoint: finalPhase.endpoint,
    epochStart: finalPhase.epochStart,
    epochEnd: finalPhase.epochEnd,
    saturatedEndpoints: classification.saturatedEndpoints.map(
      endpoint => DebugOutpostEndpointsType[endpoint]
    ),
    missingEndpoints: classification.missingEndpoints.map(
      endpoint => DebugOutpostEndpointsType[endpoint]
    ),
    observedNonRequiredEndpoints:
      classification.observedNonRequiredEndpoints.map(
        endpoint => DebugOutpostEndpointsType[endpoint]
      ),
    phaseResults
  }
}
