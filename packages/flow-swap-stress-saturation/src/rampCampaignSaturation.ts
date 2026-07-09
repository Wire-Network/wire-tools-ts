import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import type { StressRampIterationOutcome } from "./rampController.js"

/** Required endpoint aggregation across one stress ramp campaign. */
export type CampaignSaturation = {
  /** Required Ethereum endpoints saturated across all completed iterations. */
  readonly saturatedEndpoints: readonly string[]
  /** Required Ethereum endpoints still missing across the campaign. */
  readonly missingEndpoints: readonly string[]
  /** Non-required endpoints observed as diagnostic saturation. */
  readonly observedNonRequiredEndpoints: readonly string[]
}

/** Create the empty endpoint aggregation state for a fresh ramp campaign. */
export function emptyCampaignSaturation(): CampaignSaturation {
  return {
    saturatedEndpoints: [],
    missingEndpoints: requiredEndpointNames(),
    observedNonRequiredEndpoints: []
  }
}

/**
 * Merge one iteration's endpoint observations into campaign-level aggregation.
 *
 * @param prior Endpoint aggregation from earlier iterations.
 * @param outcome Current iteration telemetry.
 * @returns Updated campaign endpoint aggregation.
 */
export function mergeCampaignSaturation(
  prior: CampaignSaturation,
  outcome: StressRampIterationOutcome
): CampaignSaturation {
  const saturatedEndpoints = mergeUnique(
      prior.saturatedEndpoints,
      outcome.saturatedEndpoints ?? []
    ),
    observedNonRequiredEndpoints = mergeUnique(
      prior.observedNonRequiredEndpoints,
      outcome.observedNonRequiredEndpoints ?? []
    ),
    missingEndpoints = requiredEndpointNames().filter(
      endpoint => !saturatedEndpoints.includes(endpoint)
    )
  return { saturatedEndpoints, missingEndpoints, observedNonRequiredEndpoints }
}

function mergeUnique(
  left: readonly string[],
  right: readonly string[]
): readonly string[] {
  return [...left, ...right.filter(value => !left.includes(value))]
}

function requiredEndpointNames(): readonly string[] {
  return [
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT],
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM]
  ]
}
