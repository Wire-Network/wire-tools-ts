import Fs from "node:fs"
import Path from "node:path"

import { RunEvidencePath } from "@wireio/test-opp-stress"

import {
  allocateRunningPersistence,
  artifactCapture,
  createPersistenceWorkspace,
  oppMetadataBytes,
  readJson,
  writeOppPair
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence observation ordinals", () => {
  it("accepts a stale subset without rolling back a newer completion", async () => {
    // Given: ordinal 0 owns A,B while ordinal 1 owns the later A,B,C snapshot.
    const workspace = createPersistenceWorkspace(),
      baseKey = writeOppPair(workspace.oppRoot, ["operator.a", "operator.b"]),
      staleRequest = artifactCapture(workspace.oppRoot, baseKey),
      staleObservation = await allocateRunningPersistence(workspace),
      older = staleObservation.beginObservation("103")
    writeOppPair(workspace.oppRoot, ["operator.a", "operator.b", "operator.c"])
    const newerRequest = artifactCapture(workspace.oppRoot, baseKey),
      newerObservation = staleObservation.beginObservation("104")
    try {
      // When: ordinal 1 is captured before the already allocated ordinal 0.
      const newerRefs = await newerObservation.captureArtifact(newerRequest),
        staleRefs = await older.captureArtifact(staleRequest),
        manifest = readJson(
          Path.join(staleObservation.runDirectory, RunEvidencePath.Manifest)
        )
      // Then: stale subset reuse is accepted and never rolls state backward.
      expect(staleRefs).toEqual(newerRefs)
      expect(manifest).toMatchObject({
        artifacts: [
          {
            firstAcceptedObservationOrdinal: "1",
            lastAcceptedObservationOrdinal: "1",
            lastAcceptedBatchOpNames: ["operator.a", "operator.b", "operator.c"]
          }
        ]
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects an out-of-order newer observation that removes an accepted name", async () => {
    // Given: ordinal 0 owns A,B,C while ordinal 1 owns a later A,B subset.
    const workspace = createPersistenceWorkspace(),
      baseKey = writeOppPair(workspace.oppRoot, [
        "operator.a",
        "operator.b",
        "operator.c"
      ]),
      firstRequest = artifactCapture(workspace.oppRoot, baseKey),
      persistence = await allocateRunningPersistence(workspace),
      firstObservation = persistence.beginObservation("103")
    Fs.writeFileSync(
      Path.join(workspace.oppRoot, `${baseKey}.metadata`),
      oppMetadataBytes(["operator.a", "operator.b"])
    )
    const removalRequest = artifactCapture(workspace.oppRoot, baseKey),
      removalObservation = persistence.beginObservation("104")
    try {
      await firstObservation.captureArtifact(firstRequest)
      // When: the later ordinal captures its strict subset.
      const removal = removalObservation.captureArtifact(removalRequest)
      // Then: append-only acceptance rejects the newer removal.
      await expect(removal).rejects.toMatchObject({
        name: "RunEvidencePersistenceError"
      })
    } finally {
      workspace.cleanup()
    }
  })
})
