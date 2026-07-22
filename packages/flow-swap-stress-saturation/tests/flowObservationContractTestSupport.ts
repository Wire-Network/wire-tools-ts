import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { type RunEvidenceEndpoint } from "@wireio/test-opp-stress"
import {
  emptyPhaseResult,
  phaseResult,
  projectPendingOppPhaseMetrics
} from "@wireio/test-flow-swap-stress-saturation"
import type {
  SwapStressMeasuredPhaseEnvelopeMetrics,
  SwapStressPhaseResult
} from "@wireio/test-flow-swap-stress-saturation"

import { strictSnapshotMetrics } from "./phaseRunnerMetricFixtures.js"
import {
  pendingObservation,
  recordedMeasuredMetrics
} from "./phaseRunnerTelemetryTestSupport.js"

/** Precision sentinel proving values beyond MAX_SAFE_INTEGER remain strings. */
export const ExactEpochStart = "900719925474099312345"

/** Ordered precision sentinel immediately after ExactEpochStart. */
export const ExactEpochEnd = "900719925474099312346"

/**
 * Build rich measured, pending, and unmeasured phase evidence.
 * @returns Complete phase fixtures covering every nested evidence branch.
 */
export function richPhaseResults(): SwapStressPhaseResult[] {
  const baseline = createEnvelopeBaseline(["existing"]),
    measured = recordedMeasuredMetrics(baseline, [
      "artifacts/opp/current.data",
      "artifacts/opp/current.metadata"
    ])
  if (
    measured.provenance.kind !== "opp_phase" ||
    measured.provenance.evidence.kind !== "recorded"
  )
    throw new Error("recorded OPP phase fixture expected")
  const recordedProvenance = measured.provenance,
    recordedEvidence = measured.provenance.evidence,
    measuredWithExactWindow: SwapStressMeasuredPhaseEnvelopeMetrics = {
      phase: measured.phase,
      saturated: true,
      envelopeCount: measured.envelopeCount,
      envelopeByteSizes: measured.envelopeByteSizes,
      endpoint: measured.endpoint,
      epochStart: ExactEpochStart,
      epochEnd: ExactEpochEnd,
      measurement: "measured",
      health: measured.health,
      malformedRecords: measured.malformedRecords,
      artifactRefs: recordedEvidence.artifactRefs,
      provenance: {
        kind: "opp_phase",
        strategy: recordedProvenance.strategy,
        window: {
          ...recordedProvenance.window,
          epochStart: ExactEpochStart,
          epochEnd: ExactEpochEnd
        },
        solanaOversized: recordedProvenance.solanaOversized,
        epochEnvelopeIndexes: recordedProvenance.epochEnvelopeIndexes,
        selectedArtifacts: recordedProvenance.selectedArtifacts,
        evidence: recordedEvidence
      }
    },
    recordedResult = phaseResult(
      "phase-1",
      {
        successes: [
          {
            index: 0,
            nonce: 1,
            id: "tx-1",
            blockNumber: 2,
            gasUsed: 3n
          }
        ],
        failures: []
      },
      {
        phase: "phase-1",
        expectedCount: 1,
        minimumObservedCount: 1,
        targetAmount: 99_970_006_000_000_000n,
        targets: [{ index: 0, address: "0xabc" }],
        observedCount: 1
      },
      measuredWithExactWindow,
      100,
      200
    ),
    secondMeasured = phaseResult(
      "phase-2",
      { successes: [], failures: [] },
      null,
      strictSnapshotMetrics({
        phase: "phase-2",
        saturated: true,
        envelopeCount: 1,
        envelopeByteSizes: [256],
        endpoint:
          DebugOutpostEndpointsType[
            DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
          ],
        epochStart: "12",
        epochEnd: "13"
      }),
      201,
      300
    ),
    pending = pendingObservation(baseline),
    pendingResult = phaseResult(
      "phase-1",
      { successes: [], failures: [] },
      null,
      projectPendingOppPhaseMetrics({
        ...pending,
        window: {
          ...pending.window,
          epochStart: ExactEpochStart,
          epochEnd: ExactEpochEnd
        }
      }),
      301,
      400
    )
  return [
    recordedResult,
    secondMeasured,
    pendingResult,
    emptyPhaseResult("quote")
  ]
}

/**
 * Select evidence-backed saturated results for controller-focused fixtures.
 * @param saturatedEndpoints Canonical endpoint claims to substantiate.
 * @returns Deep phase results supporting exactly those claims.
 */
export function saturationPhaseResults(
  saturatedEndpoints: readonly RunEvidenceEndpoint[]
): SwapStressPhaseResult[] {
  return richPhaseResults().filter(
    result =>
      result.saturated &&
      saturatedEndpoints.some(endpoint => endpoint === result.endpoint)
  )
}
