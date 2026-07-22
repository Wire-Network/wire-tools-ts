import * as Fs from "node:fs"

import {
  createEnvelopeBaseline,
  oppDebuggingPath
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  collectOppPhaseMetrics,
  OppEnvelopeTelemetryHealthKind,
  RunEvidenceEndpoint,
  type OppPhaseEvidenceSink,
  type OppPhaseMetricRequest
} from "@wireio/test-opp-stress"

import {
  makeMetricStorageDir,
  removeMetricStorageDir,
  writeInvalidMetricPair,
  writeMetricEnvelopeFixture
} from "./oppEnvelopeMetricTestSupport.js"

function request(evidenceSink: OppPhaseEvidenceSink): OppPhaseMetricRequest {
  return {
    phase: "selection",
    startedAtMs: "100",
    endedAtMs: "200",
    epochStart: 7,
    epochEnd: 7,
    endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
    baseline: { ...createEnvelopeBaseline([]), artifactRefs: [] },
    evidenceSink
  }
}

function recordingSink(
  captured: string[],
  sha256ByBaseKey: ReadonlyMap<string, string>
): OppPhaseEvidenceSink {
  return {
    beginObservation: () => ({
      ordinal: "5",
      captureArtifact: async ({ baseKey }) => {
        const dataSha256 = sha256ByBaseKey.get(baseKey)
        if (dataSha256 === undefined)
          throw new Error(`unexpected selected base key: ${baseKey}`)
        captured.push(baseKey)
        return {
          data: {
            path: `artifacts/opp/${baseKey}.data`,
            sha256: dataSha256
          },
          metadata: {
            path: `artifacts/opp/${baseKey}.metadata`,
            sha256: "b".repeat(64)
          }
        }
      }
    })
  }
}

describe("collectOppPhaseMetrics selected artifacts", () => {
  it("captures a matching valid pair when another candidate is pending", async () => {
    // Given: one rollover pair plus one invalid post-baseline candidate.
    const clusterPath = makeMetricStorageDir("pending-selection"),
      storageDir = oppDebuggingPath(clusterPath),
      captured: string[] = []
    Fs.mkdirSync(storageDir, { recursive: true })
    const valid = writeMetricEnvelopeFixture(storageDir, 1)
    writeInvalidMetricPair(storageDir, "invalid")
    try {
      // When: the pending-health snapshot is collected and recorded.
      const result = await collectOppPhaseMetrics(
        clusterPath,
        request(
          recordingSink(captured, new Map([[valid.baseKey, valid.sha256]]))
        )
      )

      // Then: valid diagnostics are captured but pending health gets no saturation.
      expect(result.health.kind).toBe(
        OppEnvelopeTelemetryHealthKind.PendingPublication
      )
      expect(result.saturated).toBe(false)
      expect(result.selectedArtifacts.map(value => value.baseKey)).toEqual([
        valid.baseKey
      ])
      expect(result.malformedRecords).toEqual(
        result.health.issues.map(issue => ({
          key: issue.baseKey,
          reason: issue.code,
          issue
        }))
      )
      expect(captured).toEqual([valid.baseKey])
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })

  it("excludes valid pairs filtered out by the requested endpoint", async () => {
    // Given: matching Ethereum and filtered Solana valid pairs.
    const clusterPath = makeMetricStorageDir("filtered-selection"),
      storageDir = oppDebuggingPath(clusterPath),
      captured: string[] = []
    Fs.mkdirSync(storageDir, { recursive: true })
    const matching = writeMetricEnvelopeFixture(storageDir, 0),
      filtered = writeMetricEnvelopeFixture(storageDir, 0, {
        endpointsType: DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
      })
    try {
      // When: collection projects only the requested endpoint.
      const result = await collectOppPhaseMetrics(
        clusterPath,
        request(
          recordingSink(
            captured,
            new Map([
              [matching.baseKey, matching.sha256],
              [filtered.baseKey, filtered.sha256]
            ])
          )
        )
      )

      // Then: only the represented metric pair is selected and captured.
      expect(result.endpoint).toBe(RunEvidenceEndpoint.OutpostEthereumDepot)
      expect(result.health.filteredCount).toBe(1)
      expect(captured).toEqual([matching.baseKey])
      expect(captured).not.toContain(filtered.baseKey)
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })

  it("captures and flattens selected pairs in epoch-index-key order", async () => {
    // Given: matching pairs created outside their canonical metric order.
    const clusterPath = makeMetricStorageDir("capture-order"),
      storageDir = oppDebuggingPath(clusterPath),
      captured: string[] = []
    Fs.mkdirSync(storageDir, { recursive: true })
    const second = writeMetricEnvelopeFixture(storageDir, 2),
      first = writeMetricEnvelopeFixture(storageDir, 0),
      middle = writeMetricEnvelopeFixture(storageDir, 1),
      fixtures = [first, middle, second]
    try {
      // When: the collector selects and records all matching metrics.
      const result = await collectOppPhaseMetrics(
        clusterPath,
        request(
          recordingSink(
            captured,
            new Map(fixtures.map(value => [value.baseKey, value.sha256]))
          )
        )
      )
      if (result.evidence.kind !== "recorded")
        throw new Error("recorded evidence expected")

      // Then: capture and flattened data/metadata refs preserve metric order.
      expect(result.selectedArtifacts.map(value => value.index)).toEqual([
        0, 1, 2
      ])
      expect(captured).toEqual(fixtures.map(value => value.baseKey))
      expect(result.evidence.artifactRefs).toEqual(
        fixtures.flatMap(value => [
          `artifacts/opp/${value.baseKey}.data`,
          `artifacts/opp/${value.baseKey}.metadata`
        ])
      )
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })

  it("selects and captures only pairs inside the requested epoch bounds", async () => {
    // Given: matching endpoint pairs at epochs 6, 7, 7, and 8.
    const clusterPath = makeMetricStorageDir("epoch-window"),
      storageDir = oppDebuggingPath(clusterPath),
      captured: string[] = []
    Fs.mkdirSync(storageDir, { recursive: true })
    const before = writeMetricEnvelopeFixture(storageDir, 0, { keyEpoch: 6 }),
      first = writeMetricEnvelopeFixture(storageDir, 0, { keyEpoch: 7 }),
      second = writeMetricEnvelopeFixture(storageDir, 1, { keyEpoch: 7 }),
      after = writeMetricEnvelopeFixture(storageDir, 0, { keyEpoch: 8 }),
      fixtures = [before, first, second, after]
    try {
      // When: collection is explicitly bounded to epoch 7.
      const result = await collectOppPhaseMetrics(clusterPath, {
        ...request(
          recordingSink(
            captured,
            new Map(fixtures.map(value => [value.baseKey, value.sha256]))
          )
        ),
        epochStart: 7,
        epochEnd: 7
      })

      // Then: only epoch 7 is represented/captured and the request window persists.
      expect(result.selectedArtifacts.map(value => value.epoch)).toEqual([7, 7])
      expect(captured).toEqual([first.baseKey, second.baseKey])
      expect(result.window).toEqual({
        startedAtMs: "100",
        endedAtMs: "200",
        epochStart: "7",
        epochEnd: "7"
      })
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })
})
