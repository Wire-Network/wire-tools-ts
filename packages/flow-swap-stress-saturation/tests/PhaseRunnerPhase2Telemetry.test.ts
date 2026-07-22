import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  createStressIdentities,
  createSwapStressPhaseRunner,
  type StressIdentities,
  type SwapStressEnvelopeMetricRequest
} from "@wireio/test-flow-swap-stress-saturation"

import {
  createRealPhaseTelemetryDeps,
  measuredCollection,
  orderedBaselineCaptureIssues
} from "./phaseRunnerTelemetryTestSupport.js"

describe("phase 2 prepared telemetry", () => {
  it("captures before payout construction, preparation, submission, wait, and collection", async () => {
    // Given: every Phase-2 boundary records its deterministic invocation order.
    const events: string[] = [],
      identities = trackedPhase2PayoutIdentities(events),
      base = createRealPhaseTelemetryDeps({
        events,
        collectEnvelopeMetrics: async request =>
          measuredCollection(request, false)
      }),
      deps = {
        ...base,
        createIdentities: () => identities,
        submitPhase2Swap: async (
          request: Parameters<typeof base.submitPhase2Swap>[0]
        ) => {
          events.push("submit:phase-2")
          return base.submitPhase2Swap(request)
        },
        returnPayoutObserver: {
          preparePayouts: async (
            request: Parameters<
              typeof base.returnPayoutObserver.waitForPayouts
            >[0]
          ) => {
            events.push("prepare:phase-2")
            await base.returnPayoutObserver.preparePayouts?.(request)
          },
          waitForPayouts: async (
            request: Parameters<
              typeof base.returnPayoutObserver.waitForPayouts
            >[0]
          ) => {
            events.push("payout:phase-2")
            return base.returnPayoutObserver.waitForPayouts(request)
          }
        }
      }

    // When: one real iteration executes both phases.
    await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: the second capture precedes every observable Phase-2 work boundary.
    const captures = events
      .map((event, index) => (event === "capture" ? index : null))
      .filter((index): index is number => index !== null)
    expect(captures).toHaveLength(2)
    const phase2Capture = captures[1]
    expect(phase2Capture).toBeDefined()
    ;[
      "construct:phase-2-payout",
      "prepare:phase-2",
      "submit:phase-2",
      "payout:phase-2",
      "collect:phase-2:DEPOT_OUTPOST_ETHEREUM"
    ].forEach(event =>
      expect(events.indexOf(event)).toBeGreaterThan(phase2Capture ?? -1)
    )
  })

  it("captures once and supplies the exact Phase-2 baseline to one canonical request", async () => {
    // Given: each phase receives a distinct baseline and canonical requests are recorded.
    const phase1Baseline = createEnvelopeBaseline(["phase-1-existing"]),
      phase2Baseline = createEnvelopeBaseline(["phase-2-existing"]),
      requests: SwapStressEnvelopeMetricRequest[] = []
    let captureCount = 0
    const captureEnvelopeBaseline = jest.fn(async () => {
        captureCount += 1
        return {
          kind: "captured" as const,
          baseline: captureCount === 1 ? phase1Baseline : phase2Baseline
        }
      }),
      deps = createRealPhaseTelemetryDeps({
        captureEnvelopeBaseline,
        collectEnvelopeMetrics: async request => {
          requests.push(request)
          return measuredCollection(request, false)
        }
      })

    // When: one iteration completes both real phases.
    await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: Phase 2 owns one capture and one request bearing the same baseline object.
    expect(captureEnvelopeBaseline).toHaveBeenCalledTimes(2)
    const phase2Requests = requests.filter(
      request => request.phase === "phase-2"
    )
    expect(phase2Requests).toHaveLength(1)
    expect(phase2Requests[0]?.baseline).toBe(phase2Baseline)
    expect(phase2Requests[0]).toMatchObject({
      startedAtMs: 1_030,
      endedAtMs: 1_040,
      endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
    })
  })

  it("returns exact empty Phase-2 evidence and performs no work when capture fails", async () => {
    // Given: Phase 1 captures successfully and the Phase-2 capture returns an exact issue.
    const phase1Baseline = createEnvelopeBaseline(["phase-1-existing"]),
      issues = orderedBaselineCaptureIssues(),
      events: string[] = [],
      times = [1_000, 1_010, 1_020, 1_030, 1_040, 1_050, 1_060],
      clock = jest.fn(() => {
        const time = times.shift()
        if (time === undefined) throw new Error("unexpected clock read")
        return time
      })
    let captureCount = 0
    const base = createRealPhaseTelemetryDeps({
        events,
        captureEnvelopeBaseline: async () => {
          captureCount += 1
          return captureCount === 1
            ? { kind: "captured", baseline: phase1Baseline }
            : { kind: "failed", issues }
        },
        collectEnvelopeMetrics: async request =>
          measuredCollection(request, false)
      }),
      deps = {
        ...base,
        clock,
        submitPhase2Swap: async (
          request: Parameters<typeof base.submitPhase2Swap>[0]
        ) => {
          events.push("submit:phase-2")
          return base.submitPhase2Swap(request)
        },
        returnPayoutObserver: {
          preparePayouts: async (
            request: Parameters<
              typeof base.returnPayoutObserver.waitForPayouts
            >[0]
          ) => {
            events.push("prepare:phase-2")
            await base.returnPayoutObserver.preparePayouts?.(request)
          },
          waitForPayouts: async (
            request: Parameters<
              typeof base.returnPayoutObserver.waitForPayouts
            >[0]
          ) => {
            events.push("payout:phase-2")
            return base.returnPayoutObserver.waitForPayouts(request)
          }
        }
      }

    // When: the iteration starts Phase 2.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: Phase 1 is retained and Phase 2 reports exact zero-work degradation.
    expect(outcome).toMatchObject({
      kind: "breakage",
      breakageCategory: "telemetry_integrity"
    })
    expect(outcome.evidence).toMatchObject({
      telemetryDegradation: { kind: "baseline_capture_failed", issues },
      phaseResults: [
        expect.objectContaining({ phase: "phase-1", txSuccesses: 1 }),
        expect.objectContaining({
          phase: "phase-2",
          measurement: "unmeasured",
          unmeasuredReason: "collection_failed",
          endpoint: "DEPOT_OUTPOST_ETHEREUM",
          txSuccesses: 0,
          txFailures: 0,
          observationStartedAtMs: 1_030,
          observationEndedAtMs: 1_040,
          payout: null
        })
      ]
    })
    expect(outcome.evidence.phaseResults[1]?.observationEndedAtMs).toBe(1_040)
    expect(clock).toHaveBeenCalledTimes(5)
    expect(events.filter(event => event === "capture")).toHaveLength(2)
    expect(events).not.toEqual(
      expect.arrayContaining([
        "prepare:phase-2",
        "submit:phase-2",
        "payout:phase-2",
        "collect:phase-2:DEPOT_OUTPOST_ETHEREUM"
      ])
    )
  })
})

function trackedPhase2PayoutIdentities(events: string[]): StressIdentities {
  const identities = createStressIdentities(1)
  return {
    ...identities,
    ethereum: identities.ethereum.map(identity => ({
      ...identity,
      get address(): string {
        events.push("construct:phase-2-payout")
        return identity.address
      }
    }))
  }
}
