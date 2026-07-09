import { runSaturationRamp } from "@wireio/test-flow-swap-stress-saturation"

import {
  createScenario,
  makeEvidenceDir,
  readEvidence,
  TestRampConfig
} from "./syntheticScenario.js"

describe("Flow: swap stress saturation synthetic ramp", () => {
  it("does not pass when only the legacy Solana endpoint saturates", async () => {
    // Given: the real phase runner contract is backed by synthetic collaborators.
    const scenario = createScenario({ saturationCount: 4 }),
      evidenceDir = makeEvidenceDir("saturated")

    // When: the ramp reaches the low test-only synthetic Solana saturation threshold.
    const result = await runSaturationRamp({
      evidenceDir,
      config: TestRampConfig,
      runIteration: scenario.runIteration
    })

    // Then: the final classification remains non-pass because no required Ethereum return leg saturated.
    expect(result.status).toBe("saturation_not_reached")
    expect(result.preserveCluster).toBe(true)
    expect(result.iterations.map(iteration => iteration.accountCount)).toEqual([
      2, 4
    ])
    expect(readEvidence(evidenceDir, 1)).toMatchObject({
      status: "saturation_not_reached",
      kind: "not_saturated",
      accountCount: 4,
      phase: "phase-2",
      envelopeCount: 2,
      endpoint: "OUTPOST_SOLANA_DEPOT",
      epochStart: 42,
      epochEnd: 43,
      preserveCluster: true
    })
    expect(scenario.phase2Requests.map(request => request.index)).toEqual([
      0, 1, 0, 1, 2, 3
    ])
  })

  it("classifies max-count exhaustion as saturation_not_reached and preserves the cluster", async () => {
    // Given: synthetic metrics never report more than one matching envelope.
    const scenario = createScenario({ saturationCount: null }),
      evidenceDir = makeEvidenceDir("not-reached")

    // When: the ramp exhausts its maximum count.
    const result = await runSaturationRamp({
      evidenceDir,
      config: TestRampConfig,
      runIteration: scenario.runIteration
    })

    // Then: exhaustion is classified explicitly instead of timing out or passing.
    expect(result.status).toBe("saturation_not_reached")
    expect(result.preserveCluster).toBe(true)
    expect(result.iterations.map(iteration => iteration.status)).toEqual([
      "not_saturated",
      "saturation_not_reached"
    ])
    expect(readEvidence(evidenceDir, 1)).toMatchObject({
      status: "saturation_not_reached",
      kind: "not_saturated",
      accountCount: 4,
      preserveCluster: true
    })
  })

  it("classifies phase-runner breakage before saturation and preserves the cluster", async () => {
    // Given: a phase 1 collaborator fails before any phase can report saturation.
    const scenario = createScenario({
        saturationCount: 4,
        phase1FailureReason: "synthetic requestSwap revert"
      }),
      evidenceDir = makeEvidenceDir("breakage")

    // When: the ramp runs the first count.
    const result = await runSaturationRamp({
      evidenceDir,
      config: TestRampConfig,
      runIteration: scenario.runIteration
    })

    // Then: the breakage is classified before saturation and retained in evidence metadata.
    expect(result.status).toBe("failed_before_saturation")
    expect(result.preserveCluster).toBe(true)
    expect(readEvidence(evidenceDir, 0)).toMatchObject({
      status: "failed_before_saturation",
      kind: "breakage",
      preserveCluster: true,
      accountCount: 2,
      phase: "phase-1",
      txSuccesses: 1,
      txFailures: 1,
      breakageReason: "phase-1 burst failed: synthetic requestSwap revert"
    })
    expect(scenario.phase2Requests).toEqual([])
  })
})
