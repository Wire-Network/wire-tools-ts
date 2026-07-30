import { match } from "ts-pattern"

import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "@wireio/test-opp-stress"

import type { BurstResult } from "./boundedBursts.js"
import { classifyEthereumAllLegsSaturation } from "./ethereumAllLegsClassification.js"
import type { SwapStressPhaseResult } from "./phaseRunnerMetricTypes.js"
import type {
  SwapStressCompletedObservation,
  SwapStressTelemetryBreakageObservation,
  SwapStressWorkloadBreakageObservation
} from "./phaseRunnerTypes.js"
import type {
  SwapStressTelemetryDegradedError,
  SwapStressTelemetryDegradation
} from "./phaseRunnerTelemetry.js"

export { burstReason, errorMessage } from "./phaseRunnerFallbacks.js"

export interface PhaseRun {
  readonly burst: BurstResult
  readonly result: SwapStressPhaseResult
  readonly payoutFailureReason: string | null
  readonly batchOperatorFailureReason: string | null
  readonly telemetryDegradation: SwapStressTelemetryDegradedError | null
}

/**
 * Build one completed observation from current phase classification.
 * @param phaseResults Complete nested phase evidence for this iteration.
 * @returns Observation-only completed callback result.
 */
export function complete(
  phaseResults: readonly SwapStressPhaseResult[]
): SwapStressCompletedObservation {
  const classification = classifyEthereumAllLegsSaturation(phaseResults)
  return {
    kind: "completed",
    saturatedEndpoints:
      classification.saturatedEndpoints.map(canonicalEndpoint),
    observedNonRequiredEndpoints:
      classification.observedNonRequiredEndpoints.map(endpointName),
    evidence: { phaseResults, telemetryDegradation: null }
  }
}

/** Inputs for one workload or telemetry-integrity breakage observation. */
export interface SwapStressBreakageInput {
  readonly phaseResults: readonly SwapStressPhaseResult[]
  readonly reason: string
  readonly degradation: SwapStressTelemetryDegradation | null
}

/**
 * Build one typed breakage observation from current phase classification.
 * @param input Phase evidence, reason, and optional telemetry degradation.
 * @returns Workload or telemetry-integrity breakage observation.
 */
export function breakage(
  input: SwapStressBreakageInput
):
  | SwapStressWorkloadBreakageObservation
  | SwapStressTelemetryBreakageObservation {
  const classification = classifyEthereumAllLegsSaturation(input.phaseResults),
    fields = {
      kind: "breakage" as const,
      saturatedEndpoints:
        classification.saturatedEndpoints.map(canonicalEndpoint),
      observedNonRequiredEndpoints:
        classification.observedNonRequiredEndpoints.map(endpointName),
      breakageReason: input.reason
    }
  return input.degradation === null
    ? {
        ...fields,
        breakageCategory: RampBreakageCategory.Workload,
        evidence: {
          phaseResults: input.phaseResults,
          telemetryDegradation: null
        }
      }
    : {
        ...fields,
        breakageCategory: RampBreakageCategory.TelemetryIntegrity,
        evidence: {
          phaseResults: input.phaseResults,
          telemetryDegradation: input.degradation
        }
      }
}

function canonicalEndpoint(
  endpoint: DebugOutpostEndpointsType
): RunEvidenceEndpoint {
  return match(endpoint)
    .with(
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      () => RunEvidenceEndpoint.OutpostEthereumDepot
    )
    .with(
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
      () => RunEvidenceEndpoint.DepotOutpostEthereum
    )
    .otherwise(() => {
      throw new TypeError(
        `Unexpected required Ethereum endpoint: ${DebugOutpostEndpointsType[endpoint]}`
      )
    })
}

function endpointName(endpoint: DebugOutpostEndpointsType): string {
  return DebugOutpostEndpointsType[endpoint]
}
