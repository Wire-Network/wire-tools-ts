import { EnvelopeIntegrityIssueCode } from "@wireio/debugging-shared"
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

describe("swap stress observation integrity regressions", () => {
  it("transports the canonical empty root-identity sentinel", async () => {
    // Given: strict baseline capture reports the canonical root-change sentinel.
    const issues = [
        {
          code: EnvelopeIntegrityIssueCode.StorageRootChanged,
          baseKey: "$storage",
          context: {
            path: "/cluster/data/opp-debugging",
            before: emptyFileIdentity(),
            after: null,
            error: null
          }
        }
      ] as const,
      observation: SwapStressIterationObservation = {
      kind: "breakage",
      saturatedEndpoints: [],
      observedNonRequiredEndpoints: [],
      breakageCategory: RampBreakageCategory.TelemetryIntegrity,
      breakageReason: "storage root changed",
      evidence: {
        phaseResults: [],
        telemetryDegradation: {
          kind: "baseline_capture_failed",
          issues
        }
      }
    }

    // When: the canonical issue crosses the flow-owned evidence parser.
    const result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => observation
    })

    // Then: the issue remains observation-backed telemetry integrity evidence.
    expect(result.iterations[0]).toMatchObject({
      observation,
      breakageCategory: RampBreakageCategory.TelemetryIntegrity
    })
    expect(
      result.iterations[0]?.observation?.evidence.telemetryDegradation
    ).toEqual({ kind: "baseline_capture_failed", issues })
  })

  it("rejects envelope indexes that omit a measured envelope", async () => {
    // Given: measured provenance reports fewer indexes than envelopes.
    const { phaseResults, phase } = recordedPhase()
    if (phase.provenance?.kind !== "opp_phase")
      throw new Error("OPP provenance fixture expected")
    Object.defineProperty(phase.provenance, "epochEnvelopeIndexes", {
      value: [0]
    })

    // When/Then: the forged evidence cannot authenticate an observation.
    await expectInvalidObservation(phaseResults)
  })

  it("rejects an omitted malformed record", async () => {
    // Given: pending health retains an issue that malformedRecords omits.
    const { phaseResults, phase } = pendingPhase()
    Object.defineProperty(phase, "malformedRecords", { value: [] })

    // When/Then: issue coverage must be exact.
    await expectInvalidObservation(phaseResults)
  })

  it("rejects a duplicated malformed record", async () => {
    // Given: one canonical health issue is represented twice.
    const { phaseResults, phase } = pendingPhase(),
      record = phase.malformedRecords[0]
    if (record === undefined)
      throw new Error("malformed record fixture expected")
    Object.defineProperty(phase, "malformedRecords", {
      value: [record, record]
    })

    // When/Then: issue multiplicity must be exact.
    await expectInvalidObservation(phaseResults)
  })

  it("rejects artifact refs detached from immutable captures", async () => {
    // Given: duplicated top-level refs agree but not with captured immutable paths.
    const { phaseResults, phase } = recordedPhase()
    if (
      phase.provenance?.kind !== "opp_phase" ||
      phase.provenance.evidence.kind !== "recorded"
    )
      throw new Error("recorded provenance fixture expected")
    const forgedRefs = ["artifacts/forged.data", "artifacts/forged.metadata"]
    Object.defineProperty(phase, "artifactRefs", { value: forgedRefs })
    Object.defineProperty(phase.provenance.evidence, "artifactRefs", {
      value: forgedRefs
    })

    // When/Then: duplicated declarations cannot replace captured provenance.
    await expectInvalidObservation(phaseResults)
  })

  it("rejects payout target count mismatch", async () => {
    // Given: payout expectedCount exceeds its destination list.
    const { phaseResults, payout } = payoutPhase()
    Object.defineProperty(payout, "expectedCount", { value: 2 })

    // When/Then: every expected payout must own one target.
    await expectInvalidObservation(phaseResults)
  })

  it("rejects duplicate payout target indexes", async () => {
    // Given: two targets claim the same producer index.
    const { phaseResults, payout } = payoutPhase()
    Object.defineProperty(payout, "expectedCount", { value: 2 })
    Object.defineProperty(payout, "targets", {
      value: [
        { index: 0, address: "0xabc" },
        { index: 0, address: "0xdef" }
      ]
    })

    // When/Then: target identity coverage must be unique.
    await expectInvalidObservation(phaseResults)
  })

  it("rejects payout target index gaps", async () => {
    // Given: a single payout target starts outside the zero-based producer range.
    const { phaseResults, payout } = payoutPhase()
    Object.defineProperty(payout, "targets", {
      value: [{ index: 1, address: "0xabc" }]
    })

    // When/Then: target indexes must cover the producer range exactly.
    await expectInvalidObservation(phaseResults)
  })

  it("rejects payout phase mismatch", async () => {
    // Given: a phase-1 result carries a phase-2 payout.
    const { phaseResults, payout } = payoutPhase()
    Object.defineProperty(payout, "phase", { value: "phase-2" })

    // When/Then: payout provenance must remain bound to its parent phase.
    await expectInvalidObservation(phaseResults)
  })
})

async function expectInvalidObservation(
  phaseResults: readonly SwapStressPhaseResult[]
): Promise<void> {
  const observation: SwapStressIterationObservation = {
      kind: "completed",
      saturatedEndpoints: RequiredEndpoints,
      observedNonRequiredEndpoints: [],
      evidence: { phaseResults, telemetryDegradation: null }
    },
    result = await runSaturationRamp({
      config: Config,
      clock: () => 1,
      runIteration: async () => observation
    })
  expect(result.iterations[0]).toMatchObject({
    observation: null,
    breakageCategory: RampBreakageCategory.InvalidObservation
  })
}

function emptyFileIdentity() {
  return {
    dev: "",
    ino: "",
    mode: "",
    nlink: "",
    size: "",
    mtimeNs: "",
    ctimeNs: ""
  }
}

function recordedPhase(): {
  readonly phaseResults: SwapStressPhaseResult[]
  readonly phase: SwapStressPhaseResult
} {
  const phaseResults = richPhaseResults(),
    phase = phaseResults[0]
  if (phase === undefined) throw new Error("recorded phase fixture expected")
  return { phaseResults, phase }
}

function pendingPhase(): {
  readonly phaseResults: SwapStressPhaseResult[]
  readonly phase: SwapStressPhaseResult
} {
  const phaseResults = richPhaseResults(),
    phase = phaseResults[2]
  if (phase === undefined) throw new Error("pending phase fixture expected")
  return { phaseResults, phase }
}

function payoutPhase(): {
  readonly phaseResults: SwapStressPhaseResult[]
  readonly payout: NonNullable<SwapStressPhaseResult["payout"]>
} {
  const { phaseResults, phase } = recordedPhase()
  if (phase.payout === null) throw new Error("payout fixture expected")
  return { phaseResults, payout: phase.payout }
}
