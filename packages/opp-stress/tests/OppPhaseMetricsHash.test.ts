import * as Fs from "node:fs"

import {
  createEnvelopeBaseline,
  oppDebuggingPath
} from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import { collectOppPhaseMetrics } from "@wireio/test-opp-stress"

import {
  makeMetricStorageDir,
  removeMetricStorageDir,
  writeMetricEnvelopeFixture
} from "./oppEnvelopeMetricTestSupport.js"

describe("collectOppPhaseMetrics capture digest", () => {
  it("rejects immutable data refs that differ from the strict pair digest", async () => {
    // Given: one strict pair and a sink returning a different immutable digest.
    const clusterPath = makeMetricStorageDir("digest-mismatch"),
      storageDir = oppDebuggingPath(clusterPath)
    Fs.mkdirSync(storageDir, { recursive: true })
    const fixture = writeMetricEnvelopeFixture(storageDir, 0)
    try {
      // When: the selected artifact capture returns the wrong data hash.
      const collection = collectOppPhaseMetrics(clusterPath, {
        phase: "digest-mismatch",
        startedAtMs: "100",
        endedAtMs: "200",
        epochStart: 7,
        epochEnd: 7,
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        baseline: { ...createEnvelopeBaseline([]), artifactRefs: [] },
        evidenceSink: {
          beginObservation: () => ({
            ordinal: "9",
            captureArtifact: async () => ({
              data: {
                path: `artifacts/opp/${fixture.baseKey}.data`,
                sha256: "f".repeat(64)
              },
              metadata: {
                path: `artifacts/opp/${fixture.baseKey}.metadata`,
                sha256: "e".repeat(64)
              }
            })
          })
        }
      })

      // Then: the complete collection rejects instead of declaring those refs.
      await expect(collection).rejects.toMatchObject({
        name: "PhaseArtifactHashMismatchError",
        baseKey: fixture.baseKey,
        expectedSha256: fixture.sha256,
        actualSha256: "f".repeat(64)
      })
    } finally {
      removeMetricStorageDir(clusterPath)
    }
  })
})
