import {
  emptyCampaignSaturation as emptyOppCampaignSaturation,
  mergeCampaignSaturation as mergeOppCampaignSaturation,
  type CampaignSaturation
} from "../stress-engine/index.js"

import {
  SwapStressRequiredEndpoints,
  type SwapStressIterationObservation
} from "./phaseRunnerTypes.js"

export type { CampaignSaturation }

/** Create the empty endpoint aggregation state for a fresh ramp campaign. */
export function emptyCampaignSaturation(): CampaignSaturation {
  return emptyOppCampaignSaturation(SwapStressRequiredEndpoints)
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
  return mergeOppCampaignSaturation(SwapStressRequiredEndpoints, prior, {
    saturatedEndpoints: outcome.saturatedEndpoints,
    observedNonRequiredEndpoints: outcome.observedNonRequiredEndpoints
  })
}
