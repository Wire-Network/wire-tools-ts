import type { OppStressRampIterationOutcome } from "./rampController.js"

/** Required and diagnostic endpoint aggregation across one OPP stress campaign. */
export type CampaignSaturation = {
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

/**
 * Merge one iteration's endpoint observations into campaign-level aggregation.
 *
 * @param requiredEndpoints Endpoint labels required for campaign success.
 * @param prior Endpoint aggregation from earlier iterations.
 * @param outcome Current iteration telemetry.
 * @returns Updated campaign endpoint aggregation.
 */
export function mergeCampaignSaturation(
  requiredEndpoints: readonly string[],
  prior: CampaignSaturation,
  outcome: OppStressRampIterationOutcome
): CampaignSaturation {
  const saturatedEndpoints = mergeUnique(
      prior.saturatedEndpoints,
      outcome.saturatedEndpoints ?? []
    ),
    observedNonRequiredEndpoints = mergeUnique(
      prior.observedNonRequiredEndpoints,
      outcome.observedNonRequiredEndpoints ?? []
    ),
    missingEndpoints = requiredEndpoints.filter(
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
