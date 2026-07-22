import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import type { EnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  RunEvidenceEndpoint,
  RunEvidenceSaturationStrategy
} from "@wireio/test-opp-stress"
import { projectOppPhaseMetrics } from "@wireio/test-flow-swap-stress-saturation"
import type {
  Phase2SwapRequest,
  SwapStressEnvelopeMetricCollectionResult,
  SwapStressEnvelopeMetricCollector,
  SwapStressEnvelopeMetricRequest,
  SwapStressPendingPhaseObservation,
  SwapStressPhaseRunnerDeps,
  SwapStressRealTelemetryDeps
} from "@wireio/test-flow-swap-stress-saturation"

import { strictSnapshotMetrics } from "./phaseRunnerMetricFixtures.js"
import { createDeps } from "./phaseRunnerTestSupport.js"

export {
  baselineCaptureIssue,
  orderedBaselineCaptureIssues
} from "./phaseRunnerBaselineCaptureTestSupport.js"

/** Real phase-runner fixture with observable prepared telemetry boundaries. */
export type PhaseTelemetryTestDeps = Extract<
  SwapStressPhaseRunnerDeps,
  { readonly telemetryKind: "real" }
> & {
  /** Phase-2 submissions prove whether terminal Phase-1 degradation stopped work. */
  readonly phase2Requests: Phase2SwapRequest[]
}

/** Controls for deterministic canonical phase telemetry tests. */
export type PhaseTelemetryTestOptions = {
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
 * Build real dependencies that expose canonical phase telemetry ordering.
 * @param options Canonical capture, collection, payout, and event controls.
 * @returns Real runner dependencies with recorded Phase-2 submissions.
 */
export function createRealPhaseTelemetryDeps(
  options: PhaseTelemetryTestOptions
): PhaseTelemetryTestDeps {
  const base = createDeps({
      ...(options.phase1PayoutFailureReason === undefined
        ? {}
        : { phase1PayoutFailureReason: options.phase1PayoutFailureReason })
    }),
    baseline = createEnvelopeBaseline(["default-existing"])
  return {
    ...base,
    telemetryKind: "real",
    getEthereumFirstNonce: async count => {
      options.events?.push(`nonce:${count}`)
      return base.getEthereumFirstNonce(count)
    },
    ethereumReserveManager: {
      requestSwap: async (...args) => {
        options.events?.push("submit:ethereum")
        return base.ethereumReserveManager.requestSwap(...args)
      }
    },
    recipientPayoutObserver: {
      preparePayouts: async request => {
        options.events?.push(`prepare:${request.phase}`)
        await base.recipientPayoutObserver.preparePayouts?.(request)
      },
      waitForPayouts: request =>
        base.recipientPayoutObserver.waitForPayouts(request)
    },
    captureEnvelopeBaseline: async () => {
      options.events?.push("capture")
      return options.captureEnvelopeBaseline === undefined
        ? { kind: "captured", baseline }
        : options.captureEnvelopeBaseline()
    },
    collectEnvelopeMetrics: async request => {
      options.events?.push(
        `collect:${request.phase}:${DebugOutpostEndpointsType[request.endpointsType]}`
      )
      return options.collectEnvelopeMetrics(request)
    }
  }
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
 * Build healthy recorded metrics with immutable baseline and artifact provenance.
 * @param baseline Canonical baseline whose identity is retained.
 * @param artifactRefs Ordered immutable observation refs.
 * @returns Healthy measured flow projection.
 */
export function recordedMeasuredMetrics(
  baseline: EnvelopeBaseline,
  artifactRefs: readonly string[]
): ReturnType<typeof projectOppPhaseMetrics> {
  return projectOppPhaseMetrics({
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
    selectedArtifacts: [
      {
        baseKey: "0000000007-outpost-ethereum-depot-a",
        epoch: 7,
        index: 0,
        dataSha256: "sha256:data",
        dataMtimeNs: "1",
        metadataMtimeNs: "2"
      }
    ],
    evidence: {
      kind: "recorded",
      baseline: {
        ...baseline,
        observationOrdinal: "3",
        artifactRefs: ["artifacts/opp/baseline.data"]
      },
      artifacts:
        artifactRefs.length === 0
          ? []
          : [
              {
                baseKey: "0000000007-outpost-ethereum-depot-a",
                immutableRefs: {
                  data: { path: artifactRefs[0], sha256: "a".repeat(64) },
                  metadata: { path: artifactRefs[1], sha256: "b".repeat(64) }
                }
              }
            ],
      artifactRefs
    }
  })
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
