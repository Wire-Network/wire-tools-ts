import {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "@wireio/test-opp-stress"
import { runSaturationRamp } from "@wireio/test-flow-swap-stress-saturation"
import type { SwapStressTelemetryBreakageObservation } from "@wireio/test-flow-swap-stress-saturation"

import { orderedBaselineCaptureIssues } from "./phaseRunnerTelemetryTestSupport.js"

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

describe("flow observation telemetry degradation", () => {
  it("retains every ordered failed-baseline issue", async () => {
    // Given: a telemetry breakage carries candidate, initiating, and close issues.
    const issues = orderedBaselineCaptureIssues(),
      observation = baselineFailureObservation(issues)

    // When: the degradation crosses the flow observation parser boundary.
    const result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: every issue survives in its original order without truncation.
    expect(
      result.iterations[0]?.observation?.evidence.telemetryDegradation
    ).toEqual({ kind: "baseline_capture_failed", issues })
  })

  it.each([
    {
      description: "an empty issues sequence",
      mutate: (degradation: object) => {
        Object.defineProperty(degradation, "issues", { value: [] })
      }
    },
    {
      description: "the singular legacy issue shape",
      mutate: (degradation: object) => {
        const issues = Reflect.get(degradation, "issues")
        if (!Array.isArray(issues) || issues[0] === undefined)
          throw new TypeError("baseline issues fixture expected")
        Reflect.deleteProperty(degradation, "issues")
        Object.defineProperty(degradation, "issue", { value: issues[0] })
      }
    }
  ])("rejects $description", async ({ mutate }) => {
    // Given: an otherwise canonical telemetry degradation has a malformed issue shape.
    const observation = baselineFailureObservation(orderedBaselineCaptureIssues()),
      degradation = observation.evidence.telemetryDegradation
    mutate(degradation)

    // When: the malformed degradation crosses the flow observation parser boundary.
    const result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: malformed or legacy issue transport cannot authenticate an observation.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.InvalidObservation
    })
  })
})

function baselineFailureObservation(
  issues: ReturnType<typeof orderedBaselineCaptureIssues>
): SwapStressTelemetryBreakageObservation {
  return {
    kind: "breakage",
    saturatedEndpoints: [],
    observedNonRequiredEndpoints: [],
    breakageCategory: RampBreakageCategory.TelemetryIntegrity,
    breakageReason: "baseline capture failed",
    evidence: {
      phaseResults: [],
      telemetryDegradation: { kind: "baseline_capture_failed", issues }
    }
  }
}
