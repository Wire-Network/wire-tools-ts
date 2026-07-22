import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "@wireio/test-opp-stress"
import { runSaturationRamp } from "@wireio/test-flow-swap-stress-saturation"
import type {
  SwapStressIterationObservation,
  SwapStressPhaseResult
} from "@wireio/test-flow-swap-stress-saturation"

import { richPhaseResults } from "./flowObservationContractTestSupport.js"

type InvalidRecordedBaselineCase = {
  readonly description: string
  readonly mutate: (baseline: object) => void
}

const Config = {
    initialCount: 1,
    multiplier: 2,
    maxCount: 1,
    phaseTimeoutMs: 30_000
  } as const,
  RequiredEndpoints = [
    RunEvidenceEndpoint.OutpostEthereumDepot,
    RunEvidenceEndpoint.DepotOutpostEthereum
  ] as const,
  InvalidRecordedBaselineCases = [
    {
      description: "missing baseKeys",
      mutate: (baseline: object) => {
        Reflect.deleteProperty(baseline, "baseKeys")
      }
    },
    {
      description: "unsorted baseKeys",
      mutate: (baseline: object) => {
        const canonical = createEnvelopeBaseline(["alpha", "zeta"])
        Object.defineProperties(baseline, {
          identity: { value: canonical.identity },
          baseKeys: { value: ["zeta", "alpha"] }
        })
      }
    },
    {
      description: "duplicate baseKeys",
      mutate: (baseline: object) => {
        const canonical = createEnvelopeBaseline(["alpha"])
        Object.defineProperties(baseline, {
          identity: { value: canonical.identity },
          baseKeys: { value: ["alpha", "alpha"] }
        })
      }
    },
    {
      description: "non-string baseKeys",
      mutate: (baseline: object) => {
        Object.defineProperty(baseline, "baseKeys", { value: ["alpha", 7] })
      }
    },
    {
      description: "identity-inconsistent baseKeys",
      mutate: (baseline: object) => {
        Object.defineProperties(baseline, {
          identity: { value: createEnvelopeBaseline(["other"]).identity },
          baseKeys: { value: ["alpha"] }
        })
      }
    }
  ] satisfies readonly InvalidRecordedBaselineCase[]

describe("recorded baseline flow boundary", () => {
  it("accepts canonical recorded baseline membership", async () => {
    // Given: a current recorded phase with canonical captured baseline membership.
    const phaseResults = richPhaseResults(),
      observation = completedObservation(phaseResults)

    // When: the observation crosses the public deferred-flow controller boundary.
    const result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: the canonical recorded evidence remains the accepted observation.
    expect(result.iterations[0]?.observation?.evidence.phaseResults).toEqual(
      phaseResults
    )
  })

  it("accepts canonical recorded baseline membership containing an empty key", async () => {
    // Given: a recorded phase whose canonical sidecar membership contains the empty key.
    const phaseResults = richPhaseResults().slice(0, 2),
      phase = phaseResults[0],
      canonical = createEnvelopeBaseline([""])
    if (
      phase?.provenance?.kind !== "opp_phase" ||
      phase.provenance.evidence.kind !== "recorded"
    )
      throw new Error("recorded provenance fixture expected")
    Object.defineProperties(phase.provenance.evidence.baseline, {
      identity: { value: canonical.identity },
      baseKeys: { value: canonical.baseKeys }
    })

    // When: the canonical empty-key observation crosses the public controller boundary.
    const result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => completedObservation(phaseResults)
    })

    // Then: canonical membership remains an accepted observation.
    expect(result.iterations[0]?.observation?.evidence.phaseResults).toEqual(
      phaseResults
    )
  })

  it.each(InvalidRecordedBaselineCases)(
    "rejects $description",
    async ({ mutate }) => {
      // Given: one recorded phase whose baseline violates canonical membership.
      const phaseResults = richPhaseResults().slice(0, 2),
        phase = phaseResults[0]
      if (
        phase?.provenance?.kind !== "opp_phase" ||
        phase.provenance.evidence.kind !== "recorded"
      )
        throw new Error("recorded provenance fixture expected")
      mutate(phase.provenance.evidence.baseline)

      // When: the malformed observation crosses the public controller boundary.
      const result = await runSaturationRamp({
        config: Config,
        clock: () => 1,
        runIteration: async () => completedObservation(phaseResults)
      })

      // Then: malformed membership is classified as invalid observation.
      expect(result.iterations[0]).toMatchObject({
        observation: null,
        breakageCategory: RampBreakageCategory.InvalidObservation
      })
    }
  )
})

function completedObservation(
  phaseResults: readonly SwapStressPhaseResult[]
): SwapStressIterationObservation {
  return {
    kind: "completed",
    saturatedEndpoints: RequiredEndpoints,
    observedNonRequiredEndpoints: [],
    evidence: { phaseResults, telemetryDegradation: null }
  }
}
