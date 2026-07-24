import * as Fs from "node:fs"

import {
  createEnvelopeBaseline,
  oppDebuggingPath
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  collectOppPhaseMetrics,
  RunEvidenceEndpoint,
  RunEvidenceSaturationStrategy,
  type OppPhaseMetricRequest,
  type RunEvidenceDecimal
} from "@wireio/test-opp-stress"

import {
  makeMetricStorageDir,
  removeMetricStorageDir,
  writeMetricEnvelopeFixture
} from "./oppEnvelopeMetricTestSupport.js"

function phaseRequest(
  evidenceSink: OppPhaseMetricRequest["evidenceSink"]
): OppPhaseMetricRequest {
  return {
    phase: "phase-a",
    startedAtMs: "10",
    endedAtMs: "20",
    epochStart: 7,
    epochEnd: 7,
    endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
    baseline: { ...createEnvelopeBaseline([]), artifactRefs: [] },
    evidenceSink
  }
}

describe("collectOppPhaseMetrics observation contract", () => {
  it("allocates evidence synchronously before the strict reader scans", async () => {
    // Given: a missing cluster whose observation allocation creates its OPP pair.
    const clusterPath = makeMetricStorageDir("allocation-order")
    removeMetricStorageDir(clusterPath)
    const beginObservation = jest.fn(() => {
      const storageDir = oppDebuggingPath(clusterPath)
      Fs.mkdirSync(storageDir, { recursive: true })
      const fixture = writeMetricEnvelopeFixture(storageDir, 1)
      return {
        ordinal: "7" as const,
        captureArtifact: jest.fn(async () => ({
          data: {
            path: `artifacts/opp/${fixture.baseKey}.data`,
            sha256: fixture.sha256
          },
          metadata: {
            path: `artifacts/opp/${fixture.baseKey}.metadata`,
            sha256: "b".repeat(64)
          }
        }))
      }
    })

    try {
      // When: the collector receives an evidence sink.
      const result = await collectOppPhaseMetrics(
        clusterPath,
        phaseRequest({ beginObservation })
      )

      // Then: allocation precedes discovery and returns canonical recorded inputs.
      expect(beginObservation).toHaveBeenCalledWith("20")
      expect(result).toMatchObject({
        phase: "phase-a",
        endpoint: RunEvidenceEndpoint.OutpostEthereumDepot,
        strategy: RunEvidenceSaturationStrategy.Rollover,
        window: {
          startedAtMs: "10",
          endedAtMs: "20",
          epochStart: "7",
          epochEnd: "7"
        },
        evidence: {
          kind: "recorded",
          baseline: { observationOrdinal: "7" }
        }
      })
      if (result.evidence.kind !== "recorded")
        throw new Error("recorded evidence expected")
      expect(result.evidence.artifactRefs).toEqual([
        result.evidence.artifacts[0]?.immutableRefs.data.path,
        result.evidence.artifacts[0]?.immutableRefs.metadata.path
      ])
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })

  it("returns correlation-only evidence when the sink is null", async () => {
    // Given: an empty canonical OPP directory and a baseline with existing refs.
    const clusterPath = makeMetricStorageDir("no-sink"),
      storageDir = oppDebuggingPath(clusterPath),
      baseline = {
        ...createEnvelopeBaseline(["old-key"]),
        artifactRefs: ["artifacts/opp/old-key.data"]
      }
    Fs.mkdirSync(storageDir, { recursive: true })
    try {
      // When: collection explicitly disables evidence recording.
      const result = await collectOppPhaseMetrics(clusterPath, {
        ...phaseRequest(null),
        baseline
      })

      // Then: correlation passes through without a fabricated ordinal or refs.
      expect(result.evidence).toEqual({
        kind: "not_recorded",
        baseline: {
          identity: baseline.identity,
          artifactRefs: baseline.artifactRefs
        }
      })
      expect(
        Object.hasOwn(result.evidence.baseline, "observationOrdinal")
      ).toBe(false)
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })

  it("returns a real ordinal and empty refs for an empty recorded scan", async () => {
    // Given: an empty OPP directory and an observation that must not capture.
    const clusterPath = makeMetricStorageDir("empty-recorded"),
      storageDir = oppDebuggingPath(clusterPath),
      captureArtifact = jest.fn(),
      baseline = {
        ...createEnvelopeBaseline(["old-key"]),
        artifactRefs: ["artifacts/opp/old-key.data"]
      },
      beginObservation = jest.fn(() => ({
        ordinal: "3" as const,
        captureArtifact
      }))
    Fs.mkdirSync(storageDir, { recursive: true })
    try {
      // When: the empty phase is collected with evidence enabled.
      const result = await collectOppPhaseMetrics(clusterPath, {
        ...phaseRequest({ beginObservation }),
        baseline
      })

      // Then: the allocation remains recorded and no fake artifact is emitted.
      expect(result.evidence).toMatchObject({
        kind: "recorded",
        baseline: {
          identity: baseline.identity,
          observationOrdinal: "3",
          artifactRefs: baseline.artifactRefs
        },
        artifacts: [],
        artifactRefs: []
      })
      expect(captureArtifact).not.toHaveBeenCalled()
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })

  it("retains a real recorded ordinal when strict scanning fails", async () => {
    // Given: a missing OPP root and an observation sink with no captures.
    const clusterPath = makeMetricStorageDir("scan-failed")
    removeMetricStorageDir(clusterPath)
    const captureArtifact = jest.fn()
    try {
      // When: allocation succeeds before the strict root failure.
      const result = await collectOppPhaseMetrics(
        clusterPath,
        phaseRequest({
          beginObservation: () => ({
            ordinal: "8",
            captureArtifact
          })
        })
      )

      // Then: scan health is preserved beside the real empty observation.
      expect(result.evidence).toMatchObject({
        kind: "recorded",
        baseline: { observationOrdinal: "8" },
        artifacts: [],
        artifactRefs: []
      })
      expect(result.health.issueCount).toBe(1)
      expect(captureArtifact).not.toHaveBeenCalled()
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })

  it("propagates capture failure without translating it to telemetry", async () => {
    // Given: one selected valid pair and a failing artifact sink.
    const clusterPath = makeMetricStorageDir("capture-failure"),
      storageDir = oppDebuggingPath(clusterPath),
      captureFailure = new Error("capture failed")
    Fs.mkdirSync(storageDir, { recursive: true })
    writeMetricEnvelopeFixture(storageDir, 0)
    try {
      // When: persistence rejects the selected capture.
      const collection = collectOppPhaseMetrics(
        clusterPath,
        phaseRequest({
          beginObservation: () => ({
            ordinal: "4",
            captureArtifact: async () => Promise.reject(captureFailure)
          })
        })
      )

      // Then: the complete phase collection rejects with the original failure.
      await expect(collection).rejects.toBe(captureFailure)
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })

  it.each([
    ["negative start", { epochStart: -1, epochEnd: 7 }],
    ["negative end", { epochStart: 7, epochEnd: -1 }],
    ["unsafe start", { epochStart: Number.MAX_SAFE_INTEGER + 1, epochEnd: 7 }],
    ["unsafe end", { epochStart: 7, epochEnd: Number.MAX_SAFE_INTEGER + 1 }],
    ["reversed", { epochStart: 8, epochEnd: 7 }]
  ])("rejects %s epoch bounds before allocation", async (_label, bounds) => {
    // Given: invalid epoch bounds and a sink whose allocation is observable.
    const clusterPath = makeMetricStorageDir("invalid-epochs"),
      beginObservation = jest.fn(() => ({
        ordinal: "10" as const,
        captureArtifact: jest.fn()
      }))
    removeMetricStorageDir(clusterPath)
    try {
      // When: the invalid request reaches the exported collector boundary.
      const collection = collectOppPhaseMetrics(clusterPath, {
        ...phaseRequest({ beginObservation }),
        ...bounds
      })

      // Then: it rejects as a TypeError without allocating or scanning.
      await expect(collection).rejects.toBeInstanceOf(TypeError)
      expect(beginObservation).not.toHaveBeenCalled()
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })

  const invalidTimestamps: readonly [
    string,
    RunEvidenceDecimal,
    RunEvidenceDecimal
  ][] = [
    ["negative start", "-1", "20"],
    ["negative end", "10", "-1"],
    ["reversed", "20", "10"]
  ]
  it.each(invalidTimestamps)(
    "rejects %s timestamp bounds before allocation",
    async (_label, startedAtMs, endedAtMs) => {
      // Given: invalid decimal timestamp ordering and an observable sink.
      const clusterPath = makeMetricStorageDir("invalid-timestamps"),
        beginObservation = jest.fn(() => ({
          ordinal: "11" as const,
          captureArtifact: jest.fn()
        }))
      removeMetricStorageDir(clusterPath)
      try {
        // When: the invalid request reaches the exported collector boundary.
        const collection = collectOppPhaseMetrics(clusterPath, {
          ...phaseRequest({ beginObservation }),
          startedAtMs,
          endedAtMs,
          epochStart: 7,
          epochEnd: 7
        })

        // Then: no observation or filesystem scan begins.
        await expect(collection).rejects.toBeInstanceOf(TypeError)
        expect(beginObservation).not.toHaveBeenCalled()
      } finally {
        removeMetricStorageDir(clusterPath)
      }
    }
  )
})
