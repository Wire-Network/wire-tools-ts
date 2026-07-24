import Fs from "node:fs"
import Path from "node:path"

import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType
} from "@wireio/opp-typescript-models"
import { collectOppPhaseMetrics } from "@wireio/test-opp-stress"

import { writeMetricEnvelopeFixture } from "./oppEnvelopeMetricTestSupport.js"
import {
  allocateRunningPersistence,
  createPersistenceWorkspace,
  sha256
} from "./run-evidence/runEvidencePersistenceTestSupport.js"

describe("collectOppPhaseMetrics artifact snapshot binding", () => {
  it("persists metadata validated by the strict scan when the source changes before capture", async () => {
    // Given: a valid pair and a real sink that mutates its source after strict scanning.
    const workspace = createPersistenceWorkspace(),
      persistence = await allocateRunningPersistence(workspace),
      fixture = writeMetricEnvelopeFixture(workspace.oppRoot, 1),
      metadataBytes = Fs.readFileSync(fixture.metadataPath),
      decoded = DebugEnvelopeMetadataRecord.fromBinary(metadataBytes),
      mutatedMetadataBytes = Buffer.from(
        DebugEnvelopeMetadataRecord.toBinary({
          ...decoded,
          batchOpNames: [...decoded.batchOpNames, "batchop.after-scan"]
        })
      )
    try {
      // When: capture starts only after replacing the source with different valid metadata.
      const result = await collectOppPhaseMetrics(workspace.clusterPath, {
        phase: "snapshot-binding",
        startedAtMs: "100",
        endedAtMs: "200",
        epochStart: 7,
        epochEnd: 7,
        endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
        baseline: { ...createEnvelopeBaseline([]), artifactRefs: [] },
        evidenceSink: {
          beginObservation: updatedAtMs => {
            const observation = persistence.beginObservation(updatedAtMs)
            return {
              ordinal: observation.ordinal,
              captureArtifact: request => {
                Fs.writeFileSync(fixture.metadataPath, mutatedMetadataBytes)
                return observation.captureArtifact(request)
              }
            }
          }
        }
      })
      if (result.evidence.kind !== "recorded")
        throw new Error("recorded evidence expected")
      const captured = result.evidence.artifacts[0]
      if (captured === undefined) throw new Error("captured artifact expected")

      // Then: immutable evidence owns the exact pre-mutation pair and hashes.
      expect(
        Fs.readFileSync(
          Path.join(persistence.runDirectory, captured.immutableRefs.data.path)
        )
      ).toEqual(fixture.dataBytes)
      expect(
        Fs.readFileSync(
          Path.join(
            persistence.runDirectory,
            captured.immutableRefs.metadata.path
          )
        )
      ).toEqual(metadataBytes)
      expect(captured.immutableRefs.data.sha256).toBe(sha256(fixture.dataBytes))
      expect(captured.immutableRefs.metadata.sha256).toBe(sha256(metadataBytes))
      expect(Fs.readFileSync(fixture.metadataPath)).toEqual(
        mutatedMetadataBytes
      )
    } finally {
      workspace.cleanup()
    }
  })
})
