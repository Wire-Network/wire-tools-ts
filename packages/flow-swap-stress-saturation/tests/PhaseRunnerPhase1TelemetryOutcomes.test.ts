import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  createSwapStressPhaseRunner,
  SwapStressTelemetryDegradedError,
  type SwapStressEnvelopeMetricCollectionResult
} from "@wireio/test-flow-swap-stress-saturation"

import {
  createRealPhaseTelemetryDeps,
  measuredCollection,
  pendingObservation,
  recordedMeasuredMetrics
} from "./phaseRunnerTelemetryTestSupport.js"

describe("phase 1 canonical telemetry outcomes", () => {
  it("preserves measured baseline identity, ordinal, artifacts, indexes, and refs", async () => {
    // Given: canonical collection returns healthy recorded evidence.
    const baseline = createEnvelopeBaseline(["existing"]),
      artifactRefs = ["artifacts/opp/a.data", "artifacts/opp/a.metadata"],
      measured = recordedMeasuredMetrics(baseline, artifactRefs),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async () => ({
          kind: "measured",
          metrics: measured
        })
      })

    // When: Phase 1 records the canonical result.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: phase execution retains every canonical provenance field verbatim.
    expect(outcome.evidence.phaseResults[0]).toMatchObject({
      measurement: "measured",
      provenance: {
        kind: "opp_phase",
        window:
          measured.provenance.kind === "opp_phase"
            ? measured.provenance.window
            : null,
        epochEnvelopeIndexes: [0, 1],
        selectedArtifacts:
          measured.provenance.kind === "opp_phase"
            ? measured.provenance.selectedArtifacts
            : null,
        evidence: {
          kind: "recorded",
          baseline: {
            identity: baseline.identity,
            observationOrdinal: "3"
          }
        }
      },
      artifactRefs
    })
  })

  it("retains pending telemetry as exact unsaturated phase data", async () => {
    // Given: canonical collection returns an incomplete recorded observation.
    const baseline = createEnvelopeBaseline(["existing"]),
      observation = pendingObservation(baseline),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async () => ({ kind: "pending", observation })
      })

    // When: one iteration awaits and accepts the pending phase observation.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: pending remains nonterminal, unsaturated, and preserves exact evidence.
    expect(outcome.kind).toBe("completed")
    expect(outcome.evidence.phaseResults[0]).toMatchObject({
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

  it("awaits deferred collection until deterministic evidence commit", async () => {
    // Given: Phase-1 collection cannot complete until the test commits evidence.
    const baseline = createEnvelopeBaseline(["existing"]),
      collectionRequested = Promise.withResolvers<void>(),
      committedCollection =
        Promise.withResolvers<SwapStressEnvelopeMetricCollectionResult>(),
      measured = measuredCollection(
        {
          phase: "phase-1",
          startedAtMs: 1,
          endedAtMs: 2,
          endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
          baseline
        },
        false
      ),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async () => {
          collectionRequested.resolve()
          return committedCollection.promise
        }
      })

    // When: collection starts, then evidence is committed without sleeping.
    const run = createSwapStressPhaseRunner(deps).runIteration(1)
    await collectionRequested.promise
    committedCollection.resolve(measured)
    const outcome = await run

    // Then: the awaited measured result completes the iteration successfully.
    expect(outcome.kind).toBe("completed")
    expect(outcome.evidence.phaseResults[0]?.measurement).toBe("measured")
  })

  it("maps deadline degradation to breakage with the final pending observation", async () => {
    // Given: canonical collection reaches its injected deadline after phase work.
    const baseline = createEnvelopeBaseline(["existing"]),
      observation = pendingObservation(baseline),
      degradation = { kind: "deadline_exhausted", observation } as const,
      error = new SwapStressTelemetryDegradedError(
        "phase-1",
        DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        degradation
      ),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async () => ({ kind: "degraded", error })
      })

    // When: one phase executes and receives the terminal typed result.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: exact degradation and executed pending phase evidence survive breakage.
    expect(outcome).toMatchObject({
      kind: "breakage",
      breakageCategory: "telemetry_integrity"
    })
    expect(outcome.evidence).toMatchObject({
      telemetryDegradation: degradation,
      phaseResults: [
        expect.objectContaining({
          measurement: "pending",
          health: observation.health,
          txSuccesses: 1,
          txFailures: 0
        })
      ]
    })
    expect(deps.phase2Requests).toEqual([])
  })

  it("propagates a plain timeout Error as infrastructure", async () => {
    // Given: the canonical collector rejects with legacy timeout-shaped text.
    const baseline = createEnvelopeBaseline(["existing"]),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async () => {
          throw new Error("Timed out waiting for: OPP evidence observed")
        }
      })

    // When / Then: only the typed degradation class is mapped by the phase runner.
    await expect(
      createSwapStressPhaseRunner(deps).runIteration(1)
    ).rejects.toThrow("Timed out waiting for: OPP evidence observed")
  })
})
