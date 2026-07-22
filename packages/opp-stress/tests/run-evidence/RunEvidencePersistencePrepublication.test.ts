import Fs from "node:fs"
import Path from "node:path"

import {
  allocateRunningPersistence,
  allocationDependencies,
  artifactCapture,
  createPersistenceWorkspace,
  iterationRecord,
  sha256,
  writeOppPair
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence prepublication snapshot", () => {
  it("owns caller bytes before queueing behind shared state", async () => {
    // Given: exact supplied bytes queue behind one blocked iteration publication.
    const workspace = createPersistenceWorkspace(),
      baseKey = writeOppPair(workspace.oppRoot, ["operator.a"]),
      request = artifactCapture(workspace.oppRoot, baseKey),
      expectedData = Buffer.from(request.dataBytes),
      expectedMetadata = Buffer.from(request.metadataBytes),
      iterationOpen = Promise.withResolvers<void>(),
      releaseIteration = Promise.withResolvers<void>()
    const persistence = await allocateRunningPersistence(workspace, {
      ...allocationDependencies(),
      atomicFileDependencies: {
        fileSystem: {
          open: async (file, flags, mode) => {
            if (flags === "wx" && file.includes(".000000.json.")) {
              iterationOpen.resolve()
              await releaseIteration.promise
            }
            return Fs.promises.open(file, flags, mode)
          }
        }
      }
    })
    try {
      const iteration = persistence.publishIteration(iterationRecord(0))
      await iterationOpen.promise
      const capture = persistence
        .beginObservation("105")
        .captureArtifact(request)
      // When: caller buffers and source files mutate before capture can dequeue.
      request.dataBytes.fill(0)
      request.metadataBytes.fill(0)
      Fs.rmSync(workspace.oppRoot, { recursive: true })
      releaseIteration.resolve()
      await iteration
      const refs = await capture
      // Then: publication uses only the synchronously owned snapshot.
      expect(
        Fs.readFileSync(Path.join(persistence.runDirectory, refs.data.path))
      ).toEqual(expectedData)
      expect(
        Fs.readFileSync(Path.join(persistence.runDirectory, refs.metadata.path))
      ).toEqual(expectedMetadata)
      expect(refs.data.sha256).toBe(sha256(expectedData))
      expect(refs.metadata.sha256).toBe(sha256(expectedMetadata))
    } finally {
      releaseIteration.resolve()
      workspace.cleanup()
    }
  })
})
