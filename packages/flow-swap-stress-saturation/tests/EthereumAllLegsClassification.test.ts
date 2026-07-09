import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  RequiredEthereumSaturationEndpoints,
  classifyEthereumAllLegsSaturation,
  type SwapStressPhaseResult
} from "@wireio/test-flow-swap-stress-saturation"

describe("classifyEthereumAllLegsSaturation", () => {
  it("returns saturated when both required Ethereum directions saturate", () => {
    // Given: both required Ethereum OPP directions rolled over during the campaign.
    const phaseResults = [
      saturatedPhase(DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT),
      saturatedPhase(DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM)
    ]

    // When: the all-legs classifier evaluates the observed phase evidence.
    const result = classifyEthereumAllLegsSaturation(phaseResults)

    // Then: the final status is success with no missing Ethereum endpoints.
    expect(result.status).toBe("saturated")
    expect(result.saturatedEndpoints).toEqual(
      RequiredEthereumSaturationEndpoints
    )
    expect(result.missingEndpoints).toEqual([])
    expect(result.observedNonRequiredEndpoints).toEqual([])
  })

  it("returns partial_saturation when only one required Ethereum direction saturates", () => {
    // Given: only the Ethereum outpost-to-depot direction rolled over.
    const phaseResults = [
      saturatedPhase(DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT)
    ]

    // When: the all-legs classifier evaluates the observed phase evidence.
    const result = classifyEthereumAllLegsSaturation(phaseResults)

    // Then: the result is non-pass and names the missing depot-to-Ethereum direction.
    expect(result.status).toBe("partial_saturation")
    expect(result.saturatedEndpoints).toEqual([
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
    ])
    expect(result.missingEndpoints).toEqual([
      DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    ])
  })

  it("returns saturation_not_reached when only Solana saturation is observed", () => {
    // Given: the previous incident's Solana direction rolled over but no Ethereum leg did.
    const phaseResults = [
      saturatedPhase(DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA)
    ]

    // When: the all-legs classifier evaluates the observed phase evidence.
    const result = classifyEthereumAllLegsSaturation(phaseResults)

    // Then: Solana is diagnostic-only and both required Ethereum directions remain missing.
    expect(result.status).toBe("saturation_not_reached")
    expect(result.saturatedEndpoints).toEqual([])
    expect(result.missingEndpoints).toEqual(RequiredEthereumSaturationEndpoints)
    expect(result.observedNonRequiredEndpoints).toEqual([
      DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
    ])
  })
})

function saturatedPhase(
  endpointsType: DebugOutpostEndpointsType
): SwapStressPhaseResult {
  return {
    phase: DebugOutpostEndpointsType[endpointsType],
    saturated: true,
    envelopeCount: 2,
    envelopeByteSizes: [256, 512],
    endpoint: DebugOutpostEndpointsType[endpointsType],
    epochStart: 20,
    epochEnd: 21,
    txSuccesses: 8,
    txFailures: 0,
    startedAtMs: 1_775_612_500_000,
    endedAtMs: 1_775_612_501_000,
    payout: null
  }
}
