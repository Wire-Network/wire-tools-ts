import {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "@wireio/test-opp-stress"
import {
  runSaturationRamp,
  type StressRampConfig,
  type SwapStressIterationObservation
} from "@wireio/test-flow-swap-stress-saturation"

import { saturationPhaseResults } from "./flowObservationContractTestSupport.js"

describe("runSaturationRamp ethereum all-legs aggregation", () => {
  it("continues after the first endpoint and passes when the second saturates later", async () => {
    // Given: each iteration saturates one distinct required Ethereum endpoint.
    const observations = [
      completedObservation([RunEvidenceEndpoint.OutpostEthereumDepot]),
      completedObservation([RunEvidenceEndpoint.DepotOutpostEthereum])
    ]

    // When: the controller aggregates required endpoints across the campaign.
    const result = await runSaturationRamp({
      config: TestConfig,
      runIteration: async input => {
        const observation = observations[input.iterationIndex]
        if (observation === undefined)
          throw new Error("iteration observation fixture missing")
        return observation
      }
    })

    // Then: success occurs only after both controller-ordered endpoints exist.
    expect(result.status).toBe("saturated")
    expect(result.preserveCluster).toBe(false)
    expect(result.iterations.map(iteration => iteration.accountCount)).toEqual([
      2, 4
    ])
    expect(result.iterations[0]).toMatchObject({
      status: "not_saturated",
      saturatedEndpoints: [RunEvidenceEndpoint.OutpostEthereumDepot],
      missingEndpoints: [RunEvidenceEndpoint.DepotOutpostEthereum]
    })
    expect(result.iterations[1]).toMatchObject({
      status: "saturated",
      saturatedEndpoints: requiredEndpointNames(),
      missingEndpoints: []
    })
  })

  it("preserves partial saturation when later workload breakage occurs", async () => {
    // Given: one endpoint saturates before a later workload breakage.
    const first = completedObservation([
      RunEvidenceEndpoint.OutpostEthereumDepot
    ])

    // When: the second iteration returns typed workload breakage.
    const result = await runSaturationRamp({
      config: TestConfig,
      runIteration: async input =>
        input.iterationIndex === 0 ? first : breakageObservation([])
    })

    // Then: breakage wins while prior endpoint saturation remains visible.
    expect(result.status).toBe("failed_before_saturation")
    expect(result.preserveCluster).toBe(true)
    expect(result.saturatedEndpoints).toEqual([
      RunEvidenceEndpoint.OutpostEthereumDepot
    ])
    expect(result.missingEndpoints).toEqual([
      RunEvidenceEndpoint.DepotOutpostEthereum
    ])
    expect(result.iterations[1]).toMatchObject({
      breakageReason: "tx reverted",
      saturatedEndpoints: [RunEvidenceEndpoint.OutpostEthereumDepot],
      missingEndpoints: [RunEvidenceEndpoint.DepotOutpostEthereum]
    })
  })

  it("does not convert all-legs breakage into success", async () => {
    // Given: one workload breakage also reports complete saturation.
    const observation = breakageObservation(requiredEndpointNames())

    // When: the controller applies breakage-before-saturation precedence.
    const result = await runSaturationRamp({
      config: TestConfig,
      runIteration: async () => observation
    })

    // Then: the failed status is preserved despite complete endpoint evidence.
    expect(result.status).toBe("failed_before_saturation")
    expect(result.preserveCluster).toBe(true)
    expect(result.saturatedEndpoints).toEqual(requiredEndpointNames())
    expect(result.missingEndpoints).toEqual([])
  })
})

const TestConfig: StressRampConfig = {
  initialCount: 2,
  multiplier: 2,
  maxCount: 4,
  phaseTimeoutMs: 30_000
}

function completedObservation(
  saturatedEndpoints: readonly RunEvidenceEndpoint[]
): SwapStressIterationObservation {
  return {
    kind: "completed",
    saturatedEndpoints,
    observedNonRequiredEndpoints: [],
    evidence: {
      phaseResults: saturationPhaseResults(saturatedEndpoints),
      telemetryDegradation: null
    }
  }
}

function breakageObservation(
  saturatedEndpoints: readonly RunEvidenceEndpoint[]
): SwapStressIterationObservation {
  return {
    kind: "breakage",
    saturatedEndpoints,
    observedNonRequiredEndpoints: [],
    breakageCategory: RampBreakageCategory.Workload,
    breakageReason: "tx reverted",
    evidence: {
      phaseResults: saturationPhaseResults(saturatedEndpoints),
      telemetryDegradation: null
    }
  }
}

function requiredEndpointNames(): readonly RunEvidenceEndpoint[] {
  return [
    RunEvidenceEndpoint.OutpostEthereumDepot,
    RunEvidenceEndpoint.DepotOutpostEthereum
  ]
}
