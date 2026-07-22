import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  createSwapStressPhaseRunner,
  SwapStressTelemetryDegradedError
} from "@wireio/test-flow-swap-stress-saturation"

import {
  createRealPhaseTelemetryDeps,
  measuredCollection,
  orderedBaselineCaptureIssues
} from "./phaseRunnerTelemetryTestSupport.js"
import { createDeps } from "./phaseRunnerTestSupport.js"

describe("phase runner telemetry classification boundary", () => {
  it("propagates a typed error thrown by Phase-2 capture unchanged", async () => {
    // Given: Phase 1 captures successfully and the Phase-2 capture collaborator throws.
    const error = typedTelemetryError("phase-2"),
      baseline = createEnvelopeBaseline(["existing"])
    let captureCount = 0
    const deps = createRealPhaseTelemetryDeps({
      captureEnvelopeBaseline: async () => {
        captureCount += 1
        if (captureCount === 2) throw error
        return { kind: "captured", baseline }
      },
      collectEnvelopeMetrics: async request =>
        measuredCollection(request, false)
    })

    // When / Then: only returned capture failures are classified as degradation.
    await expect(
      createSwapStressPhaseRunner(deps).runIteration(1)
    ).rejects.toBe(error)
  })

  it.each(["first", "second"] as const)(
    "propagates a typed error from the %s reserve snapshot unchanged",
    async snapshotPosition => {
      // Given: the selected quote snapshot collaborator throws a typed telemetry-shaped error.
      const error = typedTelemetryError("phase-1"),
        base = createDeps(),
        snapshot = await base.readReservePairSnapshot()
      let snapshotCount = 0
      const deps = {
        ...base,
        readReservePairSnapshot: async () => {
          snapshotCount += 1
          if (
            snapshotPosition === "first" ||
            (snapshotPosition === "second" && snapshotCount === 2)
          )
            throw error
          return snapshot
        }
      }

      // When / Then: reserve infrastructure remains outside Todo19 classification.
      await expect(
        createSwapStressPhaseRunner(deps).runIteration(1)
      ).rejects.toBe(error)
    }
  )

  it("propagates a typed error from an unrelated Phase 1 collaborator unchanged", async () => {
    // Given: nonce reservation throws the typed class outside telemetry preparation.
    const error = typedTelemetryError("phase-1"),
      deps = {
        ...createDeps(),
        getEthereumFirstNonce: async () => {
          throw error
        }
      }

    // When / Then: the unrelated collaborator error remains infrastructure.
    await expect(
      createSwapStressPhaseRunner(deps).runIteration(1)
    ).rejects.toBe(error)
  })

  it("propagates a typed error thrown by the capture collaborator unchanged", async () => {
    // Given: canonical capture throws instead of returning its typed failed result.
    const error = typedTelemetryError("phase-1"),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline: async () => {
          throw error
        },
        collectEnvelopeMetrics: async request =>
          measuredCollection(request, false)
      })

    // When / Then: only a returned baseline-capture failure is classified by Todo19.
    await expect(
      createSwapStressPhaseRunner(deps).runIteration(1)
    ).rejects.toBe(error)
  })
})

function typedTelemetryError(
  phase: "phase-1" | "phase-2"
): SwapStressTelemetryDegradedError {
  return new SwapStressTelemetryDegradedError(
    phase,
    DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
    { kind: "baseline_capture_failed", issues: orderedBaselineCaptureIssues() }
  )
}
