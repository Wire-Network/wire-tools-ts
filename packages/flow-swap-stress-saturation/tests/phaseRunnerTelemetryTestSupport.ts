import type { EnvelopeBaseline } from "@wireio/test-flow-swap-stress-saturation/envelope-integrity/index.js"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  RunEvidenceEndpoint,
  RunEvidenceSaturationStrategy
} from "@wireio/test-flow-swap-stress-saturation/stress-engine/index.js"
import type {
  Phase2SwapRequest,
  SwapStressEnvelopeMetricCollectionResult,
  SwapStressEnvelopeMetricCollector,
  SwapStressEnvelopeMetricRequest,
  SwapStressPendingPhaseObservation,
  SwapStressPhaseRunnerDeps,
  SwapStressRealTelemetryDeps
} from "@wireio/test-flow-swap-stress-saturation/swap-stress/index.js"

import { strictSnapshotMetrics } from "./phaseRunnerMetricFixtures.js"

export {
  baselineCaptureIssue,
  orderedBaselineCaptureIssues
} from "./phaseRunnerBaselineCaptureTestSupport.js"

/** `Extract` filter selecting the real-telemetry phase-runner deps. */
interface RealTelemetryDiscriminator {
  readonly telemetryKind: "real"
}

/** The recorded Phase-2 submissions the telemetry fixture exposes. */
interface RecordedPhase2Requests {
  /** Phase-2 submissions prove whether terminal Phase-1 degradation stopped work. */
  readonly phase2Requests: Phase2SwapRequest[]
}

/** Real phase-runner fixture with observable prepared telemetry boundaries. */
export type PhaseTelemetryTestDeps = Extract<
  SwapStressPhaseRunnerDeps,
  RealTelemetryDiscriminator
> &
  RecordedPhase2Requests

/** Controls for deterministic canonical phase telemetry tests. */
export interface PhaseTelemetryTestOptions {
  /** Optional event recorder for ordering assertions. */
  readonly events?: string[]
  /** Optional Phase-1 payout observer failure. */
  readonly phase1PayoutFailureReason?: string
  /** Optional canonical capture override. */
  readonly captureEnvelopeBaseline?: SwapStressRealTelemetryDeps["captureEnvelopeBaseline"]
  /** Canonical collector behavior under test. */
  readonly collectEnvelopeMetrics: SwapStressEnvelopeMetricCollector
}

/**
 * Build a healthy canonical collection for one real request.
 * @param request Baseline-bearing canonical request.
 * @param saturated Whether the healthy observation satisfies saturation.
 * @returns Canonical measured result.
 */
export function measuredCollection(
  request: SwapStressEnvelopeMetricRequest,
  saturated: boolean
): SwapStressEnvelopeMetricCollectionResult {
  return {
    kind: "measured",
    metrics: strictSnapshotMetrics({
      phase: request.phase,
      saturated,
      envelopeCount: 1,
      envelopeByteSizes: [256],
      endpoint: DebugOutpostEndpointsType[request.endpointsType],
      epochStart: "7",
      epochEnd: "8"
    })
  }
}

/**
 * Build an exact incomplete recorded canonical observation.
 * @param baseline Canonical baseline whose membership is retained.
 * @returns Unsaturated pending observation with structured health and refs.
 */
export function pendingObservation(
  baseline: EnvelopeBaseline
): SwapStressPendingPhaseObservation {
  const issue = {
    code: OppEnvelopeTelemetryIssueCode.MissingMetadataSidecar,
    baseKey: "0000000007-outpost-ethereum-depot-pending",
    context: { path: "/opp/pending.metadata" }
  } as const
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
      artifactRefs: []
    }
  }
}
