import * as Fs from "node:fs"
import * as Path from "node:path"

import { createEnvelopeBaseline } from "@wireio/debugging-shared"
import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  collectOppPhaseMetrics,
  RunEvidencePath,
  type OppPhaseMetricBaseline,
  type RunEvidenceDecimal,
  type RunEvidencePersistence
} from "@wireio/test-opp-stress"

import { writeMetricEnvelopeFixture } from "./oppEnvelopeMetricTestSupport.js"
import {
  allocateRunningPersistence,
  createPersistenceWorkspace,
  oppMetadataBytes,
  readJson
} from "./run-evidence/runEvidencePersistenceTestSupport.js"

type CollectionInput = {
  readonly clusterPath: string
  readonly baseline: OppPhaseMetricBaseline
  readonly evidenceSink: RunEvidencePersistence
  readonly endedAtMs: RunEvidenceDecimal
}

function collect(input: CollectionInput) {
  return collectOppPhaseMetrics(input.clusterPath, {
    phase: "evolution",
    startedAtMs: "100",
    endedAtMs: input.endedAtMs,
    epochStart: 7,
    epochEnd: 7,
    endpointsType: DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT,
    baseline: input.baseline,
    evidenceSink: input.evidenceSink
  })
}

describe("collectOppPhaseMetrics append-only evolution", () => {
  it("rejects a newer observation that removes an accepted operator", async () => {
    // Given: accepted A,B,C followed by a newer A,B descriptor snapshot.
    const workspace = createPersistenceWorkspace(),
      fixture = writeMetricEnvelopeFixture(workspace.oppRoot, 0),
      persistence = await allocateRunningPersistence(workspace),
      baseline = { ...createEnvelopeBaseline([]), artifactRefs: [] }
    try {
      Fs.writeFileSync(
        fixture.metadataPath,
        oppMetadataBytes(
          ["operator.a", "operator.b", "operator.c"],
          fixture.dataBytes
        )
      )
      await collect({
        clusterPath: workspace.clusterPath,
        baseline,
        evidenceSink: persistence,
        endedAtMs: "101"
      })

      // When: the newer removal is collected.
      Fs.writeFileSync(
        fixture.metadataPath,
        oppMetadataBytes(["operator.a", "operator.b"], fixture.dataBytes)
      )
      const removal = collect({
        clusterPath: workspace.clusterPath,
        baseline,
        evidenceSink: persistence,
        endedAtMs: "102"
      })

      // Then: persistence rejects the entire phase collection.
      await expect(removal).rejects.toMatchObject({
        name: "RunEvidencePersistenceError"
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects divergent A to A,B to A,C and retains first immutable refs", async () => {
    // Given: three newer snapshots whose third branch removes operator B.
    const workspace = createPersistenceWorkspace(),
      fixture = writeMetricEnvelopeFixture(workspace.oppRoot, 0),
      persistence = await allocateRunningPersistence(workspace),
      baseline = { ...createEnvelopeBaseline([]), artifactRefs: [] }
    try {
      Fs.writeFileSync(
        fixture.metadataPath,
        oppMetadataBytes(["operator.a"], fixture.dataBytes)
      )
      const first = await collect({
          clusterPath: workspace.clusterPath,
          baseline,
          evidenceSink: persistence,
          endedAtMs: "101"
        }),
        secondMetadata = oppMetadataBytes(
          ["operator.a", "operator.b"],
          fixture.dataBytes
        )
      Fs.writeFileSync(fixture.metadataPath, secondMetadata)
      const second = await collect({
        clusterPath: workspace.clusterPath,
        baseline,
        evidenceSink: persistence,
        endedAtMs: "102"
      })
      if (
        first.evidence.kind !== "recorded" ||
        second.evidence.kind !== "recorded"
      )
        throw new Error("recorded evidence expected")

      // When: the divergent third observation is collected.
      Fs.writeFileSync(
        fixture.metadataPath,
        oppMetadataBytes(["operator.a", "operator.c"], fixture.dataBytes)
      )
      const divergent = collect({
        clusterPath: workspace.clusterPath,
        baseline,
        evidenceSink: persistence,
        endedAtMs: "103"
      })

      // Then: it rejects while the first refs and accepted A,B state remain.
      await expect(divergent).rejects.toMatchObject({
        name: "RunEvidencePersistenceError"
      })
      expect(second.evidence.artifactRefs).toEqual(first.evidence.artifactRefs)
      expect(
        readJson(Path.join(persistence.runDirectory, RunEvidencePath.Manifest))
      ).toMatchObject({
        artifacts: [
          {
            firstAcceptedObservationOrdinal: "0",
            lastAcceptedObservationOrdinal: "1",
            lastAcceptedBatchOpNames: ["operator.a", "operator.b"]
          }
        ]
      })
    } finally {
      workspace.cleanup()
    }
  })
})
