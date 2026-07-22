import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  createSwapStressPhaseRunner,
  type SwapStressEnvelopeMetricCollectionResult,
  type SwapStressEnvelopeMetricRequest,
  type SwapStressPhaseRunnerDeps,
  type SwapStressSyntheticEnvelopeMetricCollector
} from "@wireio/test-flow-swap-stress-saturation"

import { strictSnapshotMetrics } from "./phaseRunnerMetricFixtures.js"
import {
  createRealPhaseTelemetryDeps,
  measuredCollection,
  orderedBaselineCaptureIssues
} from "./phaseRunnerTelemetryTestSupport.js"
import { createDeps } from "./phaseRunnerTestSupport.js"

describe("phase 1 prepared telemetry", () => {
  it("captures before payout preparation, nonce reservation, submission, and collection", async () => {
    // Given: every Phase-1 boundary records its deterministic invocation order.
    const events: string[] = [],
      baseline = createEnvelopeBaseline(["existing"]),
      deps = createRealPhaseTelemetryDeps({
        events,
        captureEnvelopeBaseline: async () => ({ kind: "captured", baseline }),
        collectEnvelopeMetrics: async request =>
          measuredCollection(request, false)
      })

    // When: one real iteration executes both phases.
    await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: capture is the first phase side effect and collection follows the burst.
    expect(events.slice(0, 5)).toEqual([
      "capture",
      "prepare:phase-1",
      "nonce:1",
      "submit:ethereum",
      "collect:phase-1:OUTPOST_ETHEREUM_DEPOT"
    ])
  })

  it("reuses the exact captured baseline for all three probes after payout failure", async () => {
    // Given: payout failure drives the main, source, and destination probes.
    const baseline = createEnvelopeBaseline(["existing"]),
      requests: SwapStressEnvelopeMetricRequest[] = [],
      captureEnvelopeBaseline = jest.fn(async () => ({
        kind: "captured" as const,
        baseline
      })),
      deps = createRealPhaseTelemetryDeps({
        phase1PayoutFailureReason: "payout unavailable",
        captureEnvelopeBaseline,
        collectEnvelopeMetrics: async request => {
          requests.push(request)
          return measuredCollection(request, false)
        }
      })

    // When: the failed payout triggers both diagnostic directions.
    await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: Phase 1 captures once and supplies the same baseline to exactly three probes.
    expect(captureEnvelopeBaseline).toHaveBeenCalledTimes(2)
    const phase1Requests = requests.filter(
      request => request.phase === "phase-1"
    )
    expect(phase1Requests.map(request => request.endpointsType)).toEqual([
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
    ])
    phase1Requests.forEach(request => expect(request.baseline).toBe(baseline))
  })

  it("returns typed breakage without phase work when baseline capture fails", async () => {
    // Given: canonical capture reports an exact integrity issue before phase work.
    const events: string[] = [],
      issues = orderedBaselineCaptureIssues(),
      times = [1_000, 1_010, 1_020, 1_030],
      clock = jest.fn(() => {
        const time = times.shift()
        if (time === undefined) throw new Error("unexpected clock read")
        events.push(`clock:${time}`)
        return time
      }),
      collectEnvelopeMetrics = jest.fn(
        async (
          request: SwapStressEnvelopeMetricRequest
        ): Promise<SwapStressEnvelopeMetricCollectionResult> =>
          measuredCollection(request, false)
      ),
      deps = {
        ...createRealPhaseTelemetryDeps({
          events,
          captureEnvelopeBaseline: async () => ({ kind: "failed", issues }),
          collectEnvelopeMetrics
        }),
        clock
      }

    // When: the iteration attempts to start Phase 1.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: typed degradation is exact and no payout, nonce, burst, or collection runs.
    expect(outcome).toMatchObject({
      kind: "breakage",
      breakageCategory: "telemetry_integrity"
    })
    expect(outcome.evidence).toMatchObject({
      telemetryDegradation: { kind: "baseline_capture_failed", issues },
      phaseResults: [
        expect.objectContaining({
          phase: "phase-1",
          measurement: "unmeasured",
          unmeasuredReason: "collection_failed",
          endpoint: "OUTPOST_ETHEREUM_DEPOT",
          txSuccesses: 0,
          txFailures: 0,
          observationStartedAtMs: 1_000,
          observationEndedAtMs: 1_010
        })
      ]
    })
    expect(outcome.evidence.phaseResults[0]?.observationEndedAtMs).toBe(1_010)
    expect(clock).toHaveBeenCalledTimes(2)
    expect(events).toEqual(["clock:1000", "capture", "clock:1010"])
    expect(collectEnvelopeMetrics).not.toHaveBeenCalled()
  })

  it("keeps synthetic collection baseline-free", async () => {
    // Given: a synthetic collector records every request it receives.
    const requests: Parameters<SwapStressSyntheticEnvelopeMetricCollector>[0][] =
        [],
      base = createDeps(),
      deps: SwapStressPhaseRunnerDeps = {
        ...base,
        telemetryKind: "synthetic",
        collectEnvelopeMetrics: async request => {
          requests.push(request)
          return strictSnapshotMetrics({
            phase: request.phase,
            saturated: false,
            envelopeCount: 1,
            envelopeByteSizes: [256],
            endpoint: DebugOutpostEndpointsType[request.endpointsType],
            epochStart: "7",
            epochEnd: "8"
          })
        }
      }

    // When: both synthetic phases execute.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: current behavior succeeds and no request can claim a real baseline.
    expect(outcome.kind).toBe("completed")
    expect(outcome.evidence.telemetryDegradation).toBeNull()
    expect("captureEnvelopeBaseline" in deps).toBe(false)
    expect(requests).not.toHaveLength(0)
    requests.forEach(request => expect("baseline" in request).toBe(false))
  })
})
