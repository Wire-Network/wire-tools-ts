import { RunEvidenceEndpoint } from "@wireio/test-opp-stress"
import {
  runSaturationRamp,
  type StressRampConfig,
  type StressRampEvidence,
  type SwapStressIterationObservation
} from "@wireio/test-flow-swap-stress-saturation"

import { saturationPhaseResults } from "./flowObservationContractTestSupport.js"

describe("strict Ethereum all-legs evidence", () => {
  it("records partial_saturation evidence when max count is reached with one Ethereum endpoint", async () => {
    // Given: a campaign only saturates the Ethereum outpost-to-depot direction.
    // When: the ramp reaches max count before the return Ethereum direction saturates.
    const result = await runSaturationRamp({
      config: TestConfig,
      runIteration: async () => partialIteration()
    })

    // Then: final evidence is visibly non-pass and names the missing Ethereum endpoint.
    expect(result.status).toBe("partial_saturation")
    expect(result.saturatedEndpoints).toEqual([
      RequiredEndpointNames.OutpostEthereumDepot
    ])
    expect(result.missingEndpoints).toEqual([
      RequiredEndpointNames.DepotOutpostEthereum
    ])
    expect(result.iterations[1]).toMatchObject({
      status: "partial_saturation",
      saturatedEndpoints: [RequiredEndpointNames.OutpostEthereumDepot],
      missingEndpoints: [RequiredEndpointNames.DepotOutpostEthereum],
      observedNonRequiredEndpoints: []
    })
  })

  it("rejects saturated evidence that is missing a required Ethereum endpoint", () => {
    // Given: a malformed evidence object claims success with only one required endpoint.
    const evidence = {
      status: "saturated",
      saturatedEndpoints: [RequiredEndpointNames.OutpostEthereumDepot],
      missingEndpoints: [RequiredEndpointNames.DepotOutpostEthereum]
    } satisfies Pick<
      StressRampEvidence,
      "status" | "saturatedEndpoints" | "missingEndpoints"
    >

    // When/Then: the local evidence guard rejects the impossible success shape.
    expect(() => assertStrictSaturatedEvidence(evidence)).toThrow(
      /saturated evidence missing required Ethereum endpoints/
    )
  })
})

const TestConfig: StressRampConfig = {
  initialCount: 2,
  multiplier: 2,
  maxCount: 4,
  phaseTimeoutMs: 30_000
}

const RequiredEndpointNames = {
  OutpostEthereumDepot: RunEvidenceEndpoint.OutpostEthereumDepot,
  DepotOutpostEthereum: RunEvidenceEndpoint.DepotOutpostEthereum
}

function partialIteration(): SwapStressIterationObservation {
  const saturatedEndpoints = [RequiredEndpointNames.OutpostEthereumDepot]
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

function assertStrictSaturatedEvidence(
  evidence: Pick<
    StressRampEvidence,
    "status" | "saturatedEndpoints" | "missingEndpoints"
  >
): void {
  if (evidence.status === "saturated" && evidence.missingEndpoints.length > 0) {
    throw new Error("saturated evidence missing required Ethereum endpoints")
  }
}
