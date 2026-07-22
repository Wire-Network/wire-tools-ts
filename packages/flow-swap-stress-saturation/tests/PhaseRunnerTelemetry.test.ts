import {
  createEnvelopeBaseline
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  RunEvidenceEndpoint,
  RunEvidenceSaturationStrategy
} from "@wireio/test-opp-stress"
import type {
  EmptyOppEnvelopeTelemetryHealth,
  OppEnvelopeTelemetryObservation,
  OppPhaseEnvelopeMetrics,
  PendingOppEnvelopeTelemetryHealth
} from "@wireio/test-opp-stress"
import {
  classifyOppPhaseMetrics,
  SwapStressTelemetryDegradedError
} from "@wireio/test-flow-swap-stress-saturation"

import { orderedBaselineCaptureIssues } from "./phaseRunnerTelemetryTestSupport.js"

describe("phase runner telemetry contracts", () => {
  it("classifies healthy generic telemetry as measured", () => {
    // Given: a healthy generic phase observation.
    const metrics = genericMetrics(healthyHealth(), true)

    // When: flow telemetry classifies the generic result.
    const result = classifyOppPhaseMetrics(metrics)

    // Then: the measured branch retains healthy telemetry and saturation.
    expect(result.kind).toBe("measured")
    if (result.kind !== "measured") throw new Error("measured result expected")
    expect(result.metrics.measurement).toBe("measured")
    expect(result.metrics.saturated).toBe(true)
    expect(result.metrics.health.kind).toBe(
      OppEnvelopeTelemetryHealthKind.Healthy
    )
  })

  it("classifies empty telemetry as unsaturated pending data", () => {
    // Given: an empty observation whose source incorrectly claims saturation.
    const metrics = genericMetrics(emptyHealth(), true)

    // When: flow telemetry classifies the generic result.
    const result = classifyOppPhaseMetrics(metrics)

    // Then: pending remains data and cannot claim saturation.
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("pending result expected")
    expect(result.observation.saturated).toBe(false)
    expect(result.observation.health.kind).toBe(
      OppEnvelopeTelemetryHealthKind.Empty
    )
  })

  it("preserves structured pending publication issues without throwing", () => {
    // Given: one incomplete post-baseline candidate.
    const metrics = genericMetrics(pendingHealth(), false)

    // When: flow telemetry classifies the retryable observation.
    const result = classifyOppPhaseMetrics(metrics)

    // Then: the exact issue remains available on the pending branch.
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("pending result expected")
    expect(result.observation.health).toBe(metrics.health)
  })

  it("retains ordered baseline capture issues on typed degradation", () => {
    // Given: canonical baseline discovery returned candidate, initiating, and close issues.
    const issues = orderedBaselineCaptureIssues()

    // When: later deadline policy represents it as typed telemetry degradation.
    const error = new SwapStressTelemetryDegradedError(
      "phase-1",
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      { kind: "baseline_capture_failed", issues }
    )

    // Then: consumers can distinguish the category and inspect the original issue.
    expect(error.category).toBe("telemetry_integrity")
    expect(error.degradation).toEqual({
      kind: "baseline_capture_failed",
      issues
    })
  })
})

function genericMetrics(
  health: OppEnvelopeTelemetryObservation,
  saturated: boolean
): OppPhaseEnvelopeMetrics {
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
    saturated,
    solanaOversized: false,
    envelopeCount: health.validCount,
    envelopeByteSizes: [],
    epochEnvelopeIndexes: [],
    health,
    malformedRecords: [],
    selectedArtifacts: [],
    evidence: {
      kind: "not_recorded",
      baseline: {
        identity: createEnvelopeBaseline(["existing"]).identity,
        artifactRefs: []
      }
    }
  }
}

function healthyHealth(): OppEnvelopeTelemetryObservation {
  return {
    kind: OppEnvelopeTelemetryHealthKind.Healthy,
    retryable: false,
    candidateCount: 2,
    validCount: 2,
    filteredCount: 0,
    issueCount: 0,
    issues: []
  }
}

function emptyHealth(): EmptyOppEnvelopeTelemetryHealth {
  return {
    kind: OppEnvelopeTelemetryHealthKind.Empty,
    retryable: true,
    candidateCount: 0,
    validCount: 0,
    filteredCount: 0,
    issueCount: 0,
    issues: []
  }
}

function pendingHealth(): PendingOppEnvelopeTelemetryHealth {
  const issue = {
    code: OppEnvelopeTelemetryIssueCode.MissingMetadataSidecar,
    baseKey: "0000000007-outpost-ethereum-depot-deadbeef",
    context: { path: "/opp/missing.metadata" }
  } as const
  return {
    kind: OppEnvelopeTelemetryHealthKind.PendingPublication,
    retryable: true,
    candidateCount: 1,
    validCount: 0,
    filteredCount: 0,
    issueCount: 1,
    issues: [issue]
  }
}
