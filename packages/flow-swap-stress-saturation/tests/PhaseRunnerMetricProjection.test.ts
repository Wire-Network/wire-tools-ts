import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  OppEnvelopeTelemetryHealthKind,
  RunEvidenceEndpoint,
  RunEvidenceSaturationStrategy,
  type HealthyOppEnvelopeTelemetryHealth,
  type OppPhaseEnvelopeMetrics,
  type OppPhaseMetricEvidence
} from "@wireio/test-opp-stress"
import {
  emptyMetrics,
  emptyPhaseResult,
  phaseResult,
  projectOppPhaseMetrics
} from "@wireio/test-flow-swap-stress-saturation"

describe("phase runner metric projection", () => {
  it("preserves recorded generic provenance and captured ref identity through phaseResult", () => {
    // Given: a healthy generic phase result with recorded immutable evidence.
    const baseline = createEnvelopeBaseline(["existing"]),
      artifactRefs = ["artifacts/opp/a.data", "artifacts/opp/a.metadata"],
      generic = genericMetrics({
        kind: "recorded",
        baseline: {
          ...baseline,
          observationOrdinal: "3",
          artifactRefs: ["artifacts/opp/baseline.data"]
        },
        artifacts: [],
        artifactRefs
      })

    // When: it is projected and merged with phase execution telemetry.
    const projected = projectOppPhaseMetrics(generic),
      result = phaseResult(
        "phase-1",
        { successes: [], failures: [] },
        null,
        projected,
        100,
        200
      )

    // Then: exact health, issues, provenance, and ordered captured refs survive.
    expect(result.measurement).toBe("measured")
    if (
      result.measurement !== "measured" ||
      result.provenance.kind !== "opp_phase" ||
      result.provenance.evidence.kind !== "recorded"
    )
      throw new Error("recorded measured phase expected")
    expect(result.health).toBe(generic.health)
    expect(result.malformedRecords).toBe(generic.malformedRecords)
    expect(result.provenance.evidence).toBe(generic.evidence)
    expect(result.artifactRefs).toBe(artifactRefs)
  })

  it("keeps not-recorded baseline refs nested and top-level refs empty", () => {
    // Given: generic collection correlated to existing baseline artifacts only.
    const baselineRefs = ["artifacts/opp/baseline.data"],
      generic = genericMetrics({
        kind: "not_recorded",
        baseline: {
          identity: createEnvelopeBaseline(["existing"]).identity,
          artifactRefs: baselineRefs
        }
      })

    // When: the generic result is projected for the direct flow.
    const projected = projectOppPhaseMetrics(generic)

    // Then: baseline correlation remains nested and no captured refs are claimed.
    expect(projected.measurement).toBe("measured")
    if (
      projected.measurement !== "measured" ||
      projected.provenance.kind !== "opp_phase" ||
      projected.provenance.evidence.kind !== "not_recorded"
    )
      throw new Error("not-recorded measured phase expected")
    expect(projected.provenance.evidence.baseline.artifactRefs).toBe(
      baselineRefs
    )
    expect(projected.artifactRefs).toEqual([])
  })

  it("distinguishes collection failure from a phase that never ran", () => {
    // Given: a known endpoint for a failed collection.
    const failed = emptyMetrics(
        "phase-2",
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
        "collection_failed"
      ),
      skipped = emptyPhaseResult("quote")

    // When / Then: each unmeasured branch retains its exact cause.
    expect(failed).toMatchObject({
      measurement: "unmeasured",
      unmeasuredReason: "collection_failed",
      health: null,
      provenance: null
    })
    expect(skipped).toMatchObject({
      measurement: "unmeasured",
      unmeasuredReason: "phase_not_run",
      health: null,
      provenance: null
    })
  })
})

function genericMetrics(
  evidence: OppPhaseMetricEvidence
): OppPhaseEnvelopeMetrics & {
  readonly health: HealthyOppEnvelopeTelemetryHealth
} {
  return {
    phase: "phase-1",
    endpoint: RunEvidenceEndpoint.OutpostEthereumDepot,
    strategy: RunEvidenceSaturationStrategy.Rollover,
    window: {
      startedAtMs: "100",
      endedAtMs: "200",
      epochStart: "7",
      epochEnd: "8"
    },
    saturated: false,
    solanaOversized: false,
    envelopeCount: 0,
    envelopeByteSizes: [],
    epochEnvelopeIndexes: [],
    health: {
      kind: OppEnvelopeTelemetryHealthKind.Healthy,
      retryable: false,
      candidateCount: 0,
      validCount: 0,
      filteredCount: 0,
      issueCount: 0,
      issues: []
    },
    malformedRecords: [],
    selectedArtifacts: [],
    evidence
  }
}
