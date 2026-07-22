import {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "@wireio/test-opp-stress"
import {
  runSaturationRamp,
  type SwapStressIterationObservation
} from "@wireio/test-flow-swap-stress-saturation"

import { RampFixtures } from "./constants.js"
import { saturationPhaseResults } from "./flowObservationContractTestSupport.js"

describe("runSaturationRamp", () => {
  it("doubles until the first saturated iteration", async () => {
    // Given: synthetic observations saturate at account count 16.
    const counts: number[] = []

    // When: the ramp controller runs to saturation.
    const result = await runSaturationRamp({
      config: RampFixtures.Config,
      runIteration: async ({ accountCount }) => {
        counts.push(accountCount)
        return completedObservation(
          accountCount === RampFixtures.SaturatingCount
            ? requiredEndpointNames()
            : []
        )
      }
    })

    // Then: controller-owned counts and status stop at first saturation.
    expect(result.status).toBe("saturated")
    expect(counts).toEqual([2, 4, 8, 16])
    expect(result.iterations.map(iteration => iteration.accountCount)).toEqual([
      2, 4, 8, 16
    ])
    expect(result.iterations[3]?.status).toBe("saturated")
    expect(result.preserveCluster).toBe(false)
  })

  it("stops on workload breakage and preserves the cluster", async () => {
    // Given: workload breakage appears at the second count.
    const runIteration = async ({
      accountCount
    }: {
      readonly accountCount: number
    }): Promise<SwapStressIterationObservation> =>
      accountCount === RampFixtures.BreakageCount
        ? {
            kind: "breakage",
            saturatedEndpoints: [],
            observedNonRequiredEndpoints: [],
            breakageCategory: RampBreakageCategory.Workload,
            breakageReason: "tx reverted",
            evidence: { phaseResults: [], telemetryDegradation: null }
          }
        : completedObservation([])

    // When: the ramp sees the breakage observation.
    const result = await runSaturationRamp({
      config: RampFixtures.Config,
      runIteration
    })

    // Then: controller status and preservation reflect breakage.
    expect(result.status).toBe("failed_before_saturation")
    expect(result.preserveCluster).toBe(true)
    expect(result.iterations[1]).toMatchObject({
      preserveCluster: true,
      breakageCategory: RampBreakageCategory.Workload,
      breakageReason: "tx reverted"
    })
  })

  it("continues a completed observation missing one required endpoint", async () => {
    // Given: every callback claims only one required endpoint.
    const partialEndpoints = [RunEvidenceEndpoint.OutpostEthereumDepot]

    // When: the controller reaches exact max with partial saturation.
    const result = await runSaturationRamp({
      config: RampFixtures.Config,
      runIteration: async () => completedObservation(partialEndpoints)
    })

    // Then: callback wording cannot bypass controller all-endpoint ownership.
    expect(result.status).toBe("partial_saturation")
    expect(result.preserveCluster).toBe(true)
    expect(result.iterations[0]).toMatchObject({
      status: "not_saturated",
      missingEndpoints: [RunEvidenceEndpoint.DepotOutpostEthereum]
    })
    expect(result.iterations[3]).toMatchObject({
      status: "partial_saturation",
      missingEndpoints: [RunEvidenceEndpoint.DepotOutpostEthereum]
    })
  })

  it("preserves max-count evidence when no required endpoint saturates", async () => {
    // Given: one exact-max observation contains no required saturation.
    const config = {
      initialCount: 2,
      multiplier: 2,
      maxCount: 2,
      phaseTimeoutMs: 30_000
    }

    // When: the controller stops at the safety cap.
    const result = await runSaturationRamp({
      config,
      runIteration: async () => completedObservation([])
    })

    // Then: controller-owned terminal fields request artifact preservation.
    expect(result.status).toBe("saturation_not_reached")
    expect(result.preserveCluster).toBe(true)
    expect(result.iterations[0]).toMatchObject({
      status: "saturation_not_reached",
      preserveCluster: true
    })
  })
})

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

function requiredEndpointNames(): readonly RunEvidenceEndpoint[] {
  return [
    RunEvidenceEndpoint.OutpostEthereumDepot,
    RunEvidenceEndpoint.DepotOutpostEthereum
  ]
}
