/** Required and diagnostic endpoint aggregation across one OPP stress campaign. */
export interface CampaignSaturation {
  /** Required endpoints saturated across completed iterations. */
  readonly saturatedEndpoints: readonly string[]
  /** Required endpoints still missing across the campaign. */
  readonly missingEndpoints: readonly string[]
  /** Non-required endpoints observed as diagnostic saturation. */
  readonly observedNonRequiredEndpoints: readonly string[]
}

/**
 * Create empty endpoint aggregation state for a fresh OPP stress campaign.
 *
 * @param requiredEndpoints Endpoint labels required for campaign success.
 * @returns Empty aggregation with all required endpoints marked missing.
 */
export function emptyCampaignSaturation(
  requiredEndpoints: readonly string[]
): CampaignSaturation {
  return {
    saturatedEndpoints: [],
    missingEndpoints: requiredEndpoints,
    observedNonRequiredEndpoints: []
  }
}

/** One iteration's endpoint observations merged into campaign aggregation. */
interface CampaignSaturationObservation {
  /** Endpoints this iteration observed as saturated. */
  readonly saturatedEndpoints: CampaignSaturation["saturatedEndpoints"]
  /** Non-required endpoints this iteration observed as diagnostic saturation. */
  readonly observedNonRequiredEndpoints: CampaignSaturation["observedNonRequiredEndpoints"]
}

/**
 * Merge one iteration's endpoint observations into campaign-level aggregation.
 *
 * @param requiredEndpoints Endpoint labels required for campaign success.
 * @param prior Endpoint aggregation from earlier iterations.
 * @param observation Current iteration endpoint observations.
 * @returns Updated campaign endpoint aggregation.
 */
export function mergeCampaignSaturation(
  requiredEndpoints: readonly string[],
  prior: CampaignSaturation,
  observation: CampaignSaturationObservation
): CampaignSaturation {
  const saturatedSet = new Set([
      ...prior.saturatedEndpoints,
      ...observation.saturatedEndpoints
    ]),
    saturatedEndpoints = requiredEndpoints.filter(endpoint =>
      saturatedSet.has(endpoint)
    ),
    missingEndpoints = requiredEndpoints.filter(
      endpoint => !saturatedSet.has(endpoint)
    ),
    observedNonRequiredEndpoints = [
      ...new Set([
        ...prior.observedNonRequiredEndpoints,
        ...observation.observedNonRequiredEndpoints
      ])
    ].filter(endpoint => !requiredEndpoints.includes(endpoint))
  return { saturatedEndpoints, missingEndpoints, observedNonRequiredEndpoints }
}
