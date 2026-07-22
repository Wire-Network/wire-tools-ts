import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  RunEvidenceEndpoint,
  RunEvidenceSaturationStrategy
} from "@wireio/test-opp-stress"
import {
  projectOppPhaseMetrics,
  type SwapStressPendingPhaseObservation
} from "@wireio/test-flow-swap-stress-saturation"

/** Build healthy recorded Phase-2 metrics with immutable provenance. */
export function phase2MeasuredMetrics(
  baseline: ReturnType<typeof createEnvelopeBaseline>,
  artifactRefs: readonly string[]
): ReturnType<typeof projectOppPhaseMetrics> {
  return projectOppPhaseMetrics({
    phase: "phase-2",
    endpoint: RunEvidenceEndpoint.DepotOutpostEthereum,
    strategy: RunEvidenceSaturationStrategy.Rollover,
    window: {
      startedAtMs: "100",
      endedAtMs: "200",
      epochStart: "7",
      epochEnd: "8"
    },
    saturated: false,
    solanaOversized: false,
    envelopeCount: 2,
    envelopeByteSizes: [256, 512],
    epochEnvelopeIndexes: [0, 1],
    health: {
      kind: OppEnvelopeTelemetryHealthKind.Healthy,
      retryable: false,
      candidateCount: 2,
      validCount: 2,
      filteredCount: 0,
      issueCount: 0,
      issues: []
    },
    malformedRecords: [],
    selectedArtifacts: [],
    evidence: {
      kind: "recorded",
      baseline: {
        ...baseline,
        observationOrdinal: "3",
        artifactRefs: ["artifacts/opp/baseline.data"]
      },
      artifacts: [],
      artifactRefs
    }
  })
}

/** Build an incomplete recorded Phase-2 observation with exact pending evidence. */
export function phase2PendingObservation(
  baseline: ReturnType<typeof createEnvelopeBaseline>
): SwapStressPendingPhaseObservation {
  const issue = {
    code: OppEnvelopeTelemetryIssueCode.MissingMetadataSidecar,
    baseKey: "0000000007-depot-outpost-ethereum-pending",
    context: { path: "/opp/pending.metadata" }
  } as const
  return {
    phase: "phase-2",
    endpoint: RunEvidenceEndpoint.DepotOutpostEthereum,
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
    epochEnvelopeIndexes: [0],
    health: {
      kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
      retryable: true,
      candidateCount: 1,
      validCount: 0,
      filteredCount: 0,
      issueCount: 1,
      issues: [issue]
    },
    malformedRecords: [{ key: issue.baseKey, reason: issue.code, issue }],
    selectedArtifacts: [],
    evidence: {
      kind: "recorded",
      baseline: {
        ...baseline,
        observationOrdinal: "4",
        artifactRefs: ["artifacts/opp/baseline.data"]
      },
      artifacts: [],
      artifactRefs: ["artifacts/opp/pending.metadata"]
    }
  }
}
