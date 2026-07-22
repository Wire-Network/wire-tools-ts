import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  emptyCampaignSaturation as emptyOppCampaignSaturation,
  mergeCampaignSaturation as mergeOppCampaignSaturation,
  type CampaignSaturation
} from "@wireio/test-opp-stress"

import type { SwapStressIterationObservation } from "./phaseRunnerTypes.js"

export type { CampaignSaturation }

/** Create the empty endpoint aggregation state for a fresh ramp campaign. */
export function emptyCampaignSaturation(): CampaignSaturation {
  return emptyOppCampaignSaturation(requiredEndpointNames())
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
  outcome: SwapStressIterationObservation
): CampaignSaturation {
  return mergeOppCampaignSaturation(requiredEndpointNames(), prior, {
    saturatedEndpoints: outcome.saturatedEndpoints,
    observedNonRequiredEndpoints: outcome.observedNonRequiredEndpoints
  })
}

function requiredEndpointNames(): readonly string[] {
  return [
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT],
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM]
  ]
}
