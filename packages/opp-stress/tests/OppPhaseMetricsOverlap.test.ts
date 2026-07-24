import * as Fs from "node:fs"
import * as Path from "node:path"

import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  collectOppPhaseMetrics,
  RunEvidencePath,
  type OppPhaseMetricBaseline,
  type OppPhaseMetricRequest,
  type RunEvidenceDecimal
} from "@wireio/test-opp-stress"

import { writeMetricEnvelopeFixture } from "./oppEnvelopeMetricTestSupport.js"
import {
  allocateRunningPersistence,
  createPersistenceWorkspace,
  oppMetadataBytes,
  readJson
} from "./run-evidence/runEvidencePersistenceTestSupport.js"

describe("collectOppPhaseMetrics overlapping observations", () => {
  it("retains a newer superset when delayed ordinal zero finishes last", async () => {
    // Given: one shared baseline and delayed A,B followed by immediate A,B,C.
    const workspace = createPersistenceWorkspace(),
      fixture = writeMetricEnvelopeFixture(workspace.oppRoot, 0),
      metadataFile = Path.join(
        workspace.oppRoot,
        `${fixture.baseKey}.metadata`
      ),
      reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      persistence = await allocateRunningPersistence(workspace),
      evidenceSink: OppPhaseMetricRequest["evidenceSink"] = {
        beginObservation: updatedAtMs => {
          const observation = persistence.beginObservation(updatedAtMs)
          return {
            ordinal: observation.ordinal,
            captureArtifact: async request => {
              if (observation.ordinal === "0") {
                reached.resolve()
                await release.promise
              }
              return observation.captureArtifact(request)
            }
          }
        }
      },
      baseline: OppPhaseMetricBaseline = {
        ...createEnvelopeBaseline([]),
        artifactRefs: []
      },
      collect = (endedAtMs: RunEvidenceDecimal) =>
        collectOppPhaseMetrics(workspace.clusterPath, {
          phase: "overlap",
          startedAtMs: "100",
          endedAtMs,
          epochStart: 7,
          epochEnd: 7,
          endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
          baseline,
          evidenceSink
        })
    try {
      Fs.writeFileSync(
        metadataFile,
        oppMetadataBytes(["operator.a", "operator.b"], fixture.dataBytes)
      )
      const stale = collect("103")
      await reached.promise

      // When: ordinal one accepts the superset before ordinal zero resumes.
      Fs.writeFileSync(
        metadataFile,
        oppMetadataBytes(
          ["operator.a", "operator.b", "operator.c"],
          fixture.dataBytes
        )
      )
      const newer = await collect("104")
      release.resolve()
      const older = await stale
      if (
        newer.evidence.kind !== "recorded" ||
        older.evidence.kind !== "recorded"
      )
        throw new Error("recorded evidence expected")

      // Then: probes share correlation but keep distinct ordinals and first refs.
      expect(older.evidence.baseline).toMatchObject({
        identity: baseline.identity,
        observationOrdinal: "0",
        artifactRefs: baseline.artifactRefs
      })
      expect(newer.evidence.baseline).toMatchObject({
        identity: baseline.identity,
        observationOrdinal: "1",
        artifactRefs: baseline.artifactRefs
      })
      expect(older.evidence.artifactRefs).toEqual(newer.evidence.artifactRefs)
      expect(
        readJson(Path.join(persistence.runDirectory, RunEvidencePath.Manifest))
      ).toMatchObject({
        artifacts: [
          {
            firstAcceptedObservationOrdinal: "1",
            lastAcceptedObservationOrdinal: "1",
            lastAcceptedBatchOpNames: ["operator.a", "operator.b", "operator.c"]
          }
        ]
      })
    } finally {
      release.resolve()
      workspace.cleanup()
    }
  })
})
