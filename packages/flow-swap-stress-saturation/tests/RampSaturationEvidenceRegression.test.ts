import {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "@wireio/test-opp-stress"
import { runSaturationRamp } from "@wireio/test-flow-swap-stress-saturation"
import type { SwapStressIterationObservation } from "@wireio/test-flow-swap-stress-saturation"

import {
  ExactEpochStart,
  richPhaseResults
} from "./flowObservationContractTestSupport.js"

const Config = {
    initialCount: 1,
    multiplier: 2,
    maxCount: 1,
    phaseTimeoutMs: 30_000
  } as const,
  RequiredEndpoints = [
    RunEvidenceEndpoint.OutpostEthereumDepot,
    RunEvidenceEndpoint.DepotOutpostEthereum
  ] as const

describe("swap stress saturation evidence regressions", () => {
  it("rejects required root saturation without supporting phase evidence", async () => {
    // Given: the old controller fixture claims every endpoint with no phase evidence.
    const observation = completedObservation([])

    // When: the self-fulfilling root claim crosses the flow parser.
    const result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: unsupported saturation is an invalid observation, not campaign success.
    expect(result).toMatchObject({
      status: "failed_before_saturation",
      preserveCluster: true
    })
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.InvalidObservation
    })
  })

  it("accepts matching deep saturation with bigint and exact decimals", async () => {
    // Given: deep phase evidence supports both required endpoints and exact values.
    const phaseResults = richPhaseResults(),
      observation = completedObservation(phaseResults)

    // When: the evidence-backed observation crosses the flow parser.
    const result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: valid deep evidence saturates without numeric provenance loss.
    expect(result.status).toBe("saturated")
    expect(result.iterations[0]?.observation).toEqual(observation)
    expect(
      result.iterations[0]?.observation?.evidence.phaseResults[0]?.payout
        ?.targetAmount
    ).toBe(99_970_006_000_000_000n)
    expect(
      result.iterations[0]?.observation?.evidence.phaseResults[0]?.epochStart
    ).toBe(ExactEpochStart)
  })
})

function completedObservation(
  phaseResults: ReturnType<typeof richPhaseResults>
): SwapStressIterationObservation {
  return {
    kind: "completed",
    saturatedEndpoints: RequiredEndpoints,
    observedNonRequiredEndpoints: [],
    evidence: { phaseResults, telemetryDegradation: null }
  }
}
