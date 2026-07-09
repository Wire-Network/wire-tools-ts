import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import type { SwapStressPhaseResult } from "./phaseRunnerTypes.js"

/** Required Ethereum OPP directions for a successful stress-saturation campaign. */
export const RequiredEthereumSaturationEndpoints = [
  DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
  DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
]

/** Non-required OPP directions that may be reported but never make this flow pass. */
export const DiagnosticSaturationEndpoints = [
  DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
  DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
]

/** Final all-legs classification status derived from decoded OPP debug evidence. */
export type EthereumAllLegsSaturationStatus =
  "saturated" | "partial_saturation" | "saturation_not_reached"

/** Strict Ethereum all-legs saturation classification for one ramp campaign slice. */
export type EthereumAllLegsSaturationClassification = {
  /** Final status for the observed phase evidence. */
  readonly status: EthereumAllLegsSaturationStatus
  /** Required Ethereum endpoints that saturated. */
  readonly saturatedEndpoints: readonly DebugOutpostEndpointsType[]
  /** Required Ethereum endpoints that did not saturate. */
  readonly missingEndpoints: readonly DebugOutpostEndpointsType[]
  /** Saturated non-required endpoints retained as diagnostics only. */
  readonly observedNonRequiredEndpoints: readonly DebugOutpostEndpointsType[]
}

/**
 * Classify whether observed phase evidence saturates both required Ethereum OPP directions.
 *
 * @param phaseResults Per-phase OPP envelope metrics collected from debug evidence.
 * @returns Strict all-legs status plus required and diagnostic endpoint sets.
 */
export function classifyEthereumAllLegsSaturation(
  phaseResults: readonly SwapStressPhaseResult[]
): EthereumAllLegsSaturationClassification {
  const saturatedResults = phaseResults.filter(result => result.saturated),
    saturatedEndpoints = RequiredEthereumSaturationEndpoints.filter(endpoint =>
      hasEndpoint(saturatedResults, endpoint)
    ),
    missingEndpoints = RequiredEthereumSaturationEndpoints.filter(
      endpoint => !hasEndpoint(saturatedResults, endpoint)
    ),
    observedNonRequiredEndpoints = DiagnosticSaturationEndpoints.filter(
      endpoint => hasEndpoint(saturatedResults, endpoint)
    )

  return {
    status: classifyStatus(saturatedEndpoints, missingEndpoints),
    saturatedEndpoints,
    missingEndpoints,
    observedNonRequiredEndpoints
  }
}

function hasEndpoint(
  phaseResults: readonly SwapStressPhaseResult[],
  endpoint: DebugOutpostEndpointsType
): boolean {
  const endpointName = DebugOutpostEndpointsType[endpoint]
  return phaseResults.some(result => result.endpoint === endpointName)
}

function classifyStatus(
  saturatedEndpoints: readonly DebugOutpostEndpointsType[],
  missingEndpoints: readonly DebugOutpostEndpointsType[]
): EthereumAllLegsSaturationStatus {
  if (missingEndpoints.length === 0) return "saturated"
  return saturatedEndpoints.length === 0
    ? "saturation_not_reached"
    : "partial_saturation"
}
