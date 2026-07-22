import Fs from "node:fs"
import Path from "node:path"

import { DebugEnvelopeMetadataRecord } from "@wireio/opp-typescript-models"
import {
  RunEvidencePath,
  parseRunEvidenceManifest
} from "@wireio/test-opp-stress"

import {
  allocateRunningPersistence,
  artifactCapture,
  createPersistenceWorkspace,
  readJson,
  sha256,
  TestDataBytes,
  writeOppPair
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence raw OPP capture", () => {
  it("keeps first immutable refs while accepting append-only metadata", async () => {
    // Given: a running persistence and one canonical mutable source pair.
    const workspace = createPersistenceWorkspace()
    try {
      const persistence = await allocateRunningPersistence(workspace),
        baseKey = writeOppPair(workspace.oppRoot, ["operator.a"]),
        first = await persistence
          .beginObservation("103")
          .captureArtifact(artifactCapture(workspace.oppRoot, baseKey))
      // When: later observations append B and then C.
      writeOppPair(workspace.oppRoot, ["operator.a", "operator.b"])
      const second = await persistence
        .beginObservation("104")
        .captureArtifact(artifactCapture(workspace.oppRoot, baseKey))
      writeOppPair(workspace.oppRoot, [
        "operator.a",
        "operator.b",
        "operator.c"
      ])
      const third = await persistence
          .beginObservation("105")
          .captureArtifact(artifactCapture(workspace.oppRoot, baseKey)),
        manifest = readJson(
          Path.join(persistence.runDirectory, RunEvidencePath.Manifest)
        )
      // Then: fixed refs and exact first bytes remain unchanged while state advances.
      expect(second).toEqual(first)
      expect(third).toEqual(first)
      expect(parseRunEvidenceManifest(manifest).ok).toBe(true)
      expect(manifest).toMatchObject({
        artifacts: [
          {
            baseKey,
            firstImmutableRefs: first,
            firstAcceptedObservationOrdinal: "0",
            lastAcceptedObservationOrdinal: "2",
            lastAcceptedBatchOpNames: ["operator.a", "operator.b", "operator.c"]
          }
        ]
      })
      const dataFile = Path.join(persistence.runDirectory, first.data.path),
        metadataFile = Path.join(persistence.runDirectory, first.metadata.path)
      expect(Fs.readFileSync(dataFile)).toEqual(TestDataBytes)
      expect(first.data.sha256).toBe(sha256(TestDataBytes))
      expect(Fs.statSync(dataFile).mode & 0o777).toBe(0o600)
      expect(Fs.statSync(metadataFile).mode & 0o777).toBe(0o600)
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects replacement, checksum, malformed metadata, and data changes", async () => {
    // Given: first immutable A and accepted A,B state.
    const workspace = createPersistenceWorkspace()
    try {
      const persistence = await allocateRunningPersistence(workspace),
        baseKey = writeOppPair(workspace.oppRoot, ["operator.a"])
      await persistence
        .beginObservation("103")
        .captureArtifact(artifactCapture(workspace.oppRoot, baseKey))
      writeOppPair(workspace.oppRoot, ["operator.a", "operator.b"])
      await persistence
        .beginObservation("104")
        .captureArtifact(artifactCapture(workspace.oppRoot, baseKey))
      const metadataFile = Path.join(workspace.oppRoot, `${baseKey}.metadata`),
        dataFile = Path.join(workspace.oppRoot, `${baseKey}.data`)
      // When/Then: removing B by replacing it with C is rejected.
      writeOppPair(workspace.oppRoot, ["operator.a", "operator.c"])
      await expect(
        persistence
          .beginObservation("105")
          .captureArtifact(artifactCapture(workspace.oppRoot, baseKey))
      ).rejects.toMatchObject({ name: "RunEvidencePersistenceError" })
      // When/Then: malformed and checksum-mismatched metadata are rejected.
      Fs.writeFileSync(metadataFile, Buffer.from([0xff]))
      await expect(
        persistence
          .beginObservation("106")
          .captureArtifact(artifactCapture(workspace.oppRoot, baseKey))
      ).rejects.toMatchObject({ name: "RunEvidencePersistenceError" })
      Fs.writeFileSync(
        metadataFile,
        DebugEnvelopeMetadataRecord.toBinary({
          checksum: 1n,
          batchOpNames: ["operator.a", "operator.b"]
        })
      )
      await expect(
        persistence
          .beginObservation("107")
          .captureArtifact(artifactCapture(workspace.oppRoot, baseKey))
      ).rejects.toMatchObject({ name: "RunEvidencePersistenceError" })
      // When/Then: changed data cannot reuse the canonical key or first refs.
      Fs.writeFileSync(dataFile, Buffer.from("changed"))
      await expect(
        persistence
          .beginObservation("108")
          .captureArtifact(artifactCapture(workspace.oppRoot, baseKey))
      ).rejects.toMatchObject({ name: "RunEvidencePersistenceError" })
      expect(
        readJson(Path.join(persistence.runDirectory, RunEvidencePath.Manifest))
      ).toMatchObject({
        artifacts: [
          {
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
