import {
  captureEnvelopeBaseline,
  createEnvelopeBaseline,
  oppDebuggingPath
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  OppEnvelopeTelemetryHealthKind,
  RunEvidenceEndpoint,
  RunEvidenceSaturationStrategy,
  collectOppPhaseMetrics
} from "@wireio/test-opp-stress"
import type { OppPhaseEnvelopeMetrics } from "@wireio/test-opp-stress"
import {
  createSwapStressPhaseRunner,
  RealFlowMetricPolling
} from "@wireio/test-flow-swap-stress-saturation"
import type { SwapStressPhaseRunnerDeps } from "@wireio/test-flow-swap-stress-saturation"
import { sleep } from "@wireio/test-cluster-tool"

import { createDeps } from "./phaseRunnerTestSupport.js"
import { orderedBaselineCaptureIssues } from "./phaseRunnerTelemetryTestSupport.js"
import { createRealPhaseTelemetryDependencies } from "./real/realPhaseTelemetry.js"

jest.mock("@wireio/debugging-shared", () => ({
  ...jest.requireActual<typeof import("@wireio/debugging-shared")>(
    "@wireio/debugging-shared"
  ),
  captureEnvelopeBaseline: jest.fn()
}))

jest.mock("@wireio/test-opp-stress", () => ({
  ...jest.requireActual<typeof import("@wireio/test-opp-stress")>(
    "@wireio/test-opp-stress"
  ),
  collectOppPhaseMetrics: jest.fn()
}))

jest.mock("@wireio/test-cluster-tool", () => ({
  ...jest.requireActual<typeof import("@wireio/test-cluster-tool")>(
    "@wireio/test-cluster-tool"
  ),
  sleep: jest.fn()
}))

const captureEnvelopeBaselineMock = jest.mocked(captureEnvelopeBaseline),
  collectOppPhaseMetricsMock = jest.mocked(collectOppPhaseMetrics),
  sleepMock = jest.mocked(sleep)

describe("createRealPhaseTelemetryDependencies", () => {
  beforeEach(() => {
    jest.resetAllMocks()
  })

  it("captures canonically and consumes the supplied baseline once", async () => {
    // Given: canonical capture and generic collection return healthy telemetry.
    const clusterPath = "/cluster",
      baseline = createEnvelopeBaseline(["existing"]),
      generic = genericMetrics()
    captureEnvelopeBaselineMock.mockResolvedValue({
      kind: "captured",
      baseline
    })
    collectOppPhaseMetricsMock.mockResolvedValue(generic)
    const telemetry = createRealPhaseTelemetryDependencies(clusterPath)

    // When: a caller captures, then explicitly supplies that baseline to collection.
    const capture = await telemetry.captureEnvelopeBaseline(),
      result = await telemetry.collectEnvelopeMetrics({
        phase: "phase-1",
        startedAtMs: 100,
        endedAtMs: 200,
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        baseline
      })

    // Then: capture uses canonical storage and collection neither recaptures nor invents a baseline.
    expect(capture).toEqual({ kind: "captured", baseline })
    expect(captureEnvelopeBaselineMock).toHaveBeenCalledTimes(1)
    expect(captureEnvelopeBaselineMock).toHaveBeenCalledWith(
      oppDebuggingPath(clusterPath)
    )
    expect(collectOppPhaseMetricsMock).toHaveBeenCalledTimes(1)
    expect(collectOppPhaseMetricsMock).toHaveBeenCalledWith(clusterPath, {
      phase: "phase-1",
      startedAtMs: "100",
      endedAtMs: "200",
      epochStart: 0,
      epochEnd: Number.MAX_SAFE_INTEGER,
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      baseline: { ...baseline, artifactRefs: [] },
      evidenceSink: null
    })
    expect(result).toEqual({
      kind: "measured",
      metrics: expect.objectContaining({
        measurement: "measured",
        health: generic.health
      })
    })
  })

  it("retries failed canonical capture before any metric collection", async () => {
    // Given: canonical capture fails once before repairing after one fixed wait.
    const clusterPath = "/cluster",
      failed = {
        kind: "failed" as const,
        issues: orderedBaselineCaptureIssues()
      },
      baseline = createEnvelopeBaseline(["repaired"]),
      captured = { kind: "captured" as const, baseline },
      waitsMs: number[] = []
    let nowMs = 0
    captureEnvelopeBaselineMock
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(captured)
    const telemetry = createRealPhaseTelemetryDependencies(clusterPath, null, {
      now: () => nowMs,
      wait: async milliseconds => {
        waitsMs.push(milliseconds)
        nowMs += milliseconds
      }
    })

    // When: the real dependency captures its pre-phase baseline.
    const result = await telemetry.captureEnvelopeBaseline()

    // Then: the fixed poll repairs canonically without collecting phase metrics.
    expect(result).toBe(captured)
    expect(captureEnvelopeBaselineMock).toHaveBeenCalledTimes(2)
    expect(captureEnvelopeBaselineMock).toHaveBeenNthCalledWith(
      1,
      oppDebuggingPath(clusterPath)
    )
    expect(captureEnvelopeBaselineMock).toHaveBeenNthCalledWith(
      2,
      oppDebuggingPath(clusterPath)
    )
    expect(waitsMs).toEqual([RealFlowMetricPolling.LongPollIntervalMs])
    expect(collectOppPhaseMetricsMock).not.toHaveBeenCalled()
  })

  it("uses the injected runtime for baseline and pending metric polling", async () => {
    // Given: baseline and metric snapshots each require one deterministic retry.
    const baseline = createEnvelopeBaseline(["repaired"]),
      waitsMs: number[] = [],
      nowCalls: number[] = []
    let nowMs = 0
    captureEnvelopeBaselineMock
      .mockResolvedValueOnce({
        kind: "failed",
        issues: orderedBaselineCaptureIssues()
      })
      .mockResolvedValueOnce({ kind: "captured", baseline })
    collectOppPhaseMetricsMock
      .mockResolvedValueOnce({
        ...genericMetrics(),
        health: {
          kind: OppEnvelopeTelemetryHealthKind.Empty,
          retryable: true,
          candidateCount: 0,
          validCount: 0,
          filteredCount: 0,
          issueCount: 0,
          issues: []
        }
      })
      .mockResolvedValueOnce(genericMetrics())
    sleepMock.mockResolvedValue(undefined)
    const telemetry = createRealPhaseTelemetryDependencies("/cluster", null, {
      now: () => {
        nowCalls.push(nowMs)
        return nowMs
      },
      wait: async milliseconds => {
        waitsMs.push(milliseconds)
        nowMs += milliseconds
      }
    })

    // When: baseline repair is followed by a pending-then-measured metric sequence.
    await telemetry.captureEnvelopeBaseline()
    const result = await telemetry.collectEnvelopeMetrics({
      phase: "phase-1",
      startedAtMs: 100,
      endedAtMs: 200,
      endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
      baseline
    })

    // Then: both polling branches consume the caller's clock and waiter.
    expect(result.kind).toBe("measured")
    expect(waitsMs).toEqual([
      RealFlowMetricPolling.LongPollIntervalMs,
      RealFlowMetricPolling.LongPollIntervalMs
    ])
    expect(nowCalls).toHaveLength(6)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  it("captures and collects once canonically for each phase", async () => {
    // Given: the real one-shot capture and collector adapters are observable.
    const baseline = createEnvelopeBaseline(["existing"]),
      telemetry = createRealPhaseTelemetryDependencies("/cluster")
    captureEnvelopeBaselineMock.mockResolvedValue({
      kind: "captured",
      baseline
    })
    collectOppPhaseMetricsMock.mockResolvedValue(genericMetrics())
    const deps: SwapStressPhaseRunnerDeps = {
      ...createDeps(),
      ...telemetry
    }

    // When: both real phases run one iteration.
    await createSwapStressPhaseRunner(deps).runIteration(1)

    // Then: each phase captures once and reaches the same canonical adapter once.
    expect(captureEnvelopeBaselineMock).toHaveBeenCalledTimes(2)
    expect(collectOppPhaseMetricsMock).toHaveBeenCalledTimes(2)
    expect(collectOppPhaseMetricsMock).toHaveBeenNthCalledWith(
      1,
      "/cluster",
      expect.objectContaining({
        phase: "phase-1",
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        baseline: { ...baseline, artifactRefs: [] }
      })
    )
    expect(collectOppPhaseMetricsMock).toHaveBeenNthCalledWith(
      2,
      "/cluster",
      expect.objectContaining({
        phase: "phase-2",
        endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM,
        baseline: { ...baseline, artifactRefs: [] }
      })
    )
  })
})

function genericMetrics(): OppPhaseEnvelopeMetrics {
  const baseline = createEnvelopeBaseline(["existing"])
  return {
    phase: "phase-1",
    endpoint: RunEvidenceEndpoint.OutpostEthereumDepot,
    strategy: RunEvidenceSaturationStrategy.Rollover,
    window: {
      startedAtMs: "100",
      endedAtMs: "200",
      epochStart: "0",
      epochEnd: `${BigInt(Number.MAX_SAFE_INTEGER)}`
    },
    saturated: true,
    solanaOversized: false,
    envelopeCount: 2,
    envelopeByteSizes: [512, 512],
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
      kind: "not_recorded",
      baseline: { identity: baseline.identity, artifactRefs: [] }
    }
  }
}
