import {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "@wireio/test-opp-stress"
import { runSaturationRamp } from "@wireio/test-flow-swap-stress-saturation"
import type { SwapStressIterationObservation } from "@wireio/test-flow-swap-stress-saturation"

import {
  ExactEpochEnd,
  ExactEpochStart,
  richPhaseResults
} from "./flowObservationContractTestSupport.js"

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value
  >() => Value extends Right ? 1 : 2
    ? true
    : false

type Assert<Condition extends true> = Condition

const ForbiddenObservationKeysProof: Assert<
    Equal<
      Extract<
        keyof SwapStressIterationObservation,
        | "iterationIndex"
        | "accountCount"
        | "startedAtMs"
        | "endedAtMs"
        | "status"
        | "preserveCluster"
        | "missingEndpoints"
        | "lifecycle"
        | "phase"
        | "txSuccesses"
        | "txFailures"
      >,
      never
    >
  > = true,
  ObservationKindsProof: Assert<
    Equal<SwapStressIterationObservation["kind"], "completed" | "breakage">
  > = true

describe("swap stress observation transport", () => {
  it("preserves complete phase evidence and exact decimals through the controller", async () => {
    // Given: measured, pending, and unmeasured phases with rich nested evidence.
    const phaseResults = richPhaseResults(),
      observation: SwapStressIterationObservation = {
        kind: "completed",
        saturatedEndpoints: [
          RunEvidenceEndpoint.OutpostEthereumDepot,
          RunEvidenceEndpoint.DepotOutpostEthereum
        ],
        observedNonRequiredEndpoints: ["DEPOT_OUTPOST_SOLANA"],
        evidence: { phaseResults, telemetryDegradation: null }
      },
      clock = jest.fn().mockReturnValueOnce(700).mockReturnValueOnce(800)

    // When: the flow passes the observation directly through generic deferred mode.
    const result = await runSaturationRamp({
      config: {
        initialCount: 3,
        multiplier: 2,
        maxCount: 3,
        phaseTimeoutMs: 30_000
      },
      clock,
      runIteration: async () => observation
    })

    // Then: controller metadata is separate and every nested phase value is unchanged.
    expect(result.iterations[0]).toMatchObject({
      iterationIndex: 0,
      accountCount: 3,
      startedAtMs: 700,
      endedAtMs: 800,
      status: "saturated",
      preserveCluster: false,
      observation
    })
    expect(result.iterations[0]?.observation?.evidence.phaseResults).toEqual(
      phaseResults
    )
    expect(
      result.iterations[0]?.observation?.evidence.phaseResults[0]?.epochStart
    ).toBe(ExactEpochStart)
    expect(
      result.iterations[0]?.observation?.evidence.phaseResults[0]?.provenance
    ).toMatchObject({
      window: { epochStart: ExactEpochStart, epochEnd: ExactEpochEnd },
      selectedArtifacts: [
        {
          baseKey: "0000000007-outpost-ethereum-depot-a",
          index: 0
        }
      ],
      evidence: {
        kind: "recorded",
        baseline: { observationOrdinal: "3" },
        artifactRefs: [
          "artifacts/opp/current.data",
          "artifacts/opp/current.metadata"
        ]
      }
    })
  })

  it("classifies malformed nested flow evidence as invalid observation", async () => {
    // Given: one phase result has an arbitrary nested root key.
    const phaseResults = richPhaseResults(),
      first = phaseResults[0]
    if (first === undefined) throw new Error("phase fixture missing")
    Object.defineProperty(first, "unexpected", {
      enumerable: true,
      value: "sentinel"
    })
    const observation: SwapStressIterationObservation = {
      kind: "completed",
      saturatedEndpoints: [],
      observedNonRequiredEndpoints: [],
      evidence: { phaseResults, telemetryDegradation: null }
    }

    // When: the exact flow evidence parser receives the safe snapshot.
    const result = await runSaturationRamp({
      config: {
        initialCount: 1,
        multiplier: 2,
        maxCount: 1,
        phaseTimeoutMs: 30_000
      },
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: the controller returns a no-observation invalid boundary failure.
    expect(result.iterations[0]).toMatchObject({
      observation: null,
      breakageCategory: RampBreakageCategory.InvalidObservation
    })
  })

  it("executes compile-time observation ownership proofs", () => {
    // Given/When/Then: forbidden controller and legacy fields are absent by type.
    expect([ForbiddenObservationKeysProof, ObservationKindsProof]).toEqual([
      true,
      true
    ])
  })
})
