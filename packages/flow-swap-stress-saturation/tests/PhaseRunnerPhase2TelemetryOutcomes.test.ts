import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { RunEvidenceEndpoint } from "@wireio/test-opp-stress"
import {
  createSwapStressPhaseRunner,
  SwapStressTelemetryDegradedError,
  type SwapStressEnvelopeMetricCollectionResult
} from "@wireio/test-flow-swap-stress-saturation"

import {
  createRealPhaseTelemetryDeps,
  measuredCollection,
  orderedBaselineCaptureIssues
} from "./phaseRunnerTelemetryTestSupport.js"
import {
  phase2MeasuredMetrics,
  phase2PendingObservation
} from "./phaseRunnerPhase2TelemetryTestSupport.js"

describe("phase 2 canonical telemetry outcomes", () => {
  it("preserves measured Phase-2 provenance, artifacts, indexes, and refs", async () => {
    // Given: canonical Phase-2 collection returns healthy recorded evidence.
    const baseline = createEnvelopeBaseline(["existing"]),
      artifactRefs = ["artifacts/opp/a.data", "artifacts/opp/a.metadata"],
      measured = phase2MeasuredMetrics(baseline, artifactRefs),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async request =>
          request.phase === "phase-2"
            ? { kind: "measured", metrics: measured }
            : measuredCollection(request, false)
      })

    // When: one iteration records the canonical Phase-2 result.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: Phase 2 retains every canonical provenance field verbatim.
    expect(outcome.evidence.phaseResults[1]).toMatchObject({
      measurement: "measured",
      phase: "phase-2",
      endpoint: RunEvidenceEndpoint.DepotOutpostEthereum,
      provenance: measured.provenance,
      artifactRefs
    })
  })

  it("retains pending Phase-2 telemetry as exact unsaturated non-breakage data", async () => {
    // Given: canonical Phase-2 collection returns an incomplete recorded observation.
    const baseline = createEnvelopeBaseline(["existing"]),
      observation = phase2PendingObservation(baseline),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async request =>
          request.phase === "phase-2"
            ? { kind: "pending", observation }
            : measuredCollection(request, false)
      })

    // When: one iteration accepts the pending Phase-2 observation.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: pending remains honest, unsaturated, and preserves exact evidence.
    expect(outcome.kind).toBe("completed")
    expect(outcome.evidence.telemetryDegradation).toBeNull()
    expect(outcome.evidence.phaseResults[1]).toMatchObject({
      phase: "phase-2",
      measurement: "pending",
      saturated: false,
      health: observation.health,
      malformedRecords: observation.malformedRecords,
      provenance: {
        kind: "opp_phase",
        strategy: observation.strategy,
        window: observation.window,
        epochEnvelopeIndexes: observation.epochEnvelopeIndexes,
        selectedArtifacts: observation.selectedArtifacts,
        evidence: observation.evidence
      },
      artifactRefs:
        observation.evidence.kind === "recorded"
          ? observation.evidence.artifactRefs
          : []
    })
  })

  it("awaits a deferred Phase-2 collector until deterministic evidence commit", async () => {
    // Given: Phase-2 collection cannot complete until the test commits evidence.
    const baseline = createEnvelopeBaseline(["existing"]),
      collectionRequested = Promise.withResolvers<void>(),
      committedCollection =
        Promise.withResolvers<SwapStressEnvelopeMetricCollectionResult>(),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async request => {
          if (request.phase === "phase-1")
            return measuredCollection(request, false)
          collectionRequested.resolve()
          return committedCollection.promise
        }
      })

    // When: collection starts, then evidence is committed without timers or polling.
    const run = createSwapStressPhaseRunner(deps).runIteration(1)
    await collectionRequested.promise
    committedCollection.resolve({
      kind: "measured",
      metrics: phase2MeasuredMetrics(baseline, [])
    })
    const outcome = await run

    // Then: the runner awaited and retained the canonical measured Phase-2 result.
    expect(outcome.kind).toBe("completed")
    expect(outcome.evidence.phaseResults[1]?.measurement).toBe("measured")
    expect(outcome.evidence.phaseResults[1]?.provenance?.kind).toBe("opp_phase")
  })

  it("maps Phase-2 deadline degradation to breakage with final pending evidence", async () => {
    // Given: canonical collection returns a typed deadline with its final observation.
    const baseline = createEnvelopeBaseline(["existing"]),
      observation = phase2PendingObservation(baseline),
      degradation = { kind: "deadline_exhausted", observation } as const,
      error = new SwapStressTelemetryDegradedError(
        "phase-2",
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
        degradation
      ),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async request =>
          request.phase === "phase-2"
            ? { kind: "degraded", error }
            : measuredCollection(request, false)
      })

    // When: Phase 2 receives the typed terminal result.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: exact degradation and executed pending evidence survive breakage.
    expect(outcome).toMatchObject({
      kind: "breakage",
      breakageReason: error.message,
      breakageCategory: "telemetry_integrity"
    })
    expect(outcome.evidence).toMatchObject({
      telemetryDegradation: degradation,
      phaseResults: [
        expect.objectContaining({ phase: "phase-1" }),
        expect.objectContaining({
          phase: "phase-2",
          measurement: "pending",
          health: observation.health,
          txSuccesses: 1,
          txFailures: 0
        })
      ]
    })
  })

  it("propagates a typed baseline-capture error rejected by the Phase-2 collector unchanged", async () => {
    // Given: capture succeeded, work runs, and the collector rejects with a baseline-capture error.
    const baseline = createEnvelopeBaseline(["existing"]),
      degradation = {
        kind: "baseline_capture_failed",
        issues: orderedBaselineCaptureIssues()
      } as const,
      error = new SwapStressTelemetryDegradedError(
        "phase-2",
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
        degradation
      ),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async request => {
          if (request.phase === "phase-2") throw error
          return measuredCollection(request, false)
        }
      })

    // When / Then: the exact object rejects upward and no typed iteration result is fabricated.
    await expect(
      createSwapStressPhaseRunner(deps).runIteration(1)
    ).rejects.toBe(error)
    expect(deps.phase2Requests).toHaveLength(1)
  })

  it("gives typed Phase-2 degradation precedence over a burst failure", async () => {
    // Given: Phase-2 submission and canonical evidence both fail in classified ways.
    const baseline = createEnvelopeBaseline(["existing"]),
      observation = phase2PendingObservation(baseline),
      degradation = { kind: "deadline_exhausted", observation } as const,
      error = new SwapStressTelemetryDegradedError(
        "phase-2",
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
        degradation
      ),
      base = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async request =>
          request.phase === "phase-2"
            ? { kind: "degraded", error }
            : measuredCollection(request, false)
      }),
      deps = {
        ...base,
        submitPhase2Swap: async () => {
          throw new Error("phase-2 submit failed")
        }
      }

    // When: the runner classifies the completed Phase-2 evidence.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: evidence integrity wins over the concurrent burst classification.
    expect(outcome).toMatchObject({
      kind: "breakage",
      breakageReason: error.message,
      breakageCategory: "telemetry_integrity"
    })
    expect(outcome.evidence).toMatchObject({
      telemetryDegradation: degradation,
      phaseResults: [
        expect.any(Object),
        expect.objectContaining({ txFailures: 1 })
      ]
    })
  })

  it("gives typed Phase-2 degradation precedence over payout and batch failures", async () => {
    // Given: payout, batch-operator, and canonical evidence classification all fail.
    const baseline = createEnvelopeBaseline(["existing"]),
      observation = phase2PendingObservation(baseline),
      degradation = { kind: "deadline_exhausted", observation } as const,
      error = new SwapStressTelemetryDegradedError(
        "phase-2",
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
        degradation
      ),
      base = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async request =>
          request.phase === "phase-2"
            ? { kind: "degraded", error }
            : measuredCollection(request, false)
      }),
      deps = {
        ...base,
        returnPayoutObserver: {
          waitForPayouts: async () => {
            throw new Error("phase-2 payout failed")
          }
        },
        batchOperatorFailureProbe: async () => "phase-2 batch failure"
      }

    // When: the runner classifies the completed Phase-2 evidence.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: evidence integrity wins over payout and batch classifications.
    expect(outcome).toMatchObject({
      kind: "breakage",
      breakageReason: error.message,
      breakageCategory: "telemetry_integrity"
    })
    expect(outcome.evidence.telemetryDegradation).toEqual(degradation)
  })

  it.each([
    new Error("Timed out waiting for: phase-2 OPP evidence observed"),
    new Error("phase-2 collector storage unavailable")
  ])("propagates collector rejection unchanged: %s", async error => {
    // Given: only the Phase-2 canonical collector rejects with a plain infrastructure error.
    const baseline = createEnvelopeBaseline(["existing"]),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async request => {
          if (request.phase === "phase-2") throw error
          return measuredCollection(request, false)
        }
      })

    // When / Then: no message matching or typed degradation conversion occurs.
    await expect(
      createSwapStressPhaseRunner(deps).runIteration(1)
    ).rejects.toBe(error)
  })
})
