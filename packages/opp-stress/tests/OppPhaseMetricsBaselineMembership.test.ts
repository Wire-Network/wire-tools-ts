import * as Fs from "node:fs"

import {
  createEnvelopeBaseline,
  oppDebuggingPath
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { collectOppPhaseMetrics } from "@wireio/test-opp-stress"

import {
  makeMetricStorageDir,
  removeMetricStorageDir
} from "./oppEnvelopeMetricTestSupport.js"

describe("collectOppPhaseMetrics baseline membership evidence", () => {
  it("records the actual captured baseline key set", async () => {
    // Given: a canonical nonempty phase baseline and an empty strict scan.
    const clusterPath = makeMetricStorageDir("baseline-keys"),
      storageDir = oppDebuggingPath(clusterPath),
      baseline = {
        ...createEnvelopeBaseline(["baseline-z", "baseline-a"]),
        artifactRefs: []
      }
    Fs.mkdirSync(storageDir, { recursive: true })
    try {
      // When: the phase allocates recorded evidence.
      const result = await collectOppPhaseMetrics(clusterPath, {
        phase: "phase-a",
        startedAtMs: "10",
        endedAtMs: "20",
        epochStart: 7,
        epochEnd: 7,
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        baseline,
        evidenceSink: {
          beginObservation: () => ({
            ordinal: "5",
            captureArtifact: jest.fn()
          })
        }
      })

      // Then: persisted baseline evidence retains the exact captured key set.
      expect(result.evidence).toMatchObject({
        kind: "recorded",
        baseline: {
          identity: baseline.identity,
          baseKeys: baseline.baseKeys,
          observationOrdinal: "5",
          artifactRefs: []
        }
      })
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })
})
