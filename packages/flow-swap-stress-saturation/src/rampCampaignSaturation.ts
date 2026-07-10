import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  emptyCampaignSaturation as emptyOppCampaignSaturation,
  mergeCampaignSaturation as mergeOppCampaignSaturation,
  type CampaignSaturation
} from "@wireio/test-opp-stress"

import type { StressRampIterationOutcome } from "./rampController.js"

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
  outcome: StressRampIterationOutcome
): CampaignSaturation {
  return mergeOppCampaignSaturation(requiredEndpointNames(), prior, outcome)
}

function requiredEndpointNames(): readonly string[] {
  return [
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT],
    DebugOutpostEndpointsType[DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM]
  ]
}
