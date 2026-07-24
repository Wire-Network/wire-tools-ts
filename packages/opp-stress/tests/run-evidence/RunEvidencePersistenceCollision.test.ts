import Fs from "node:fs"
import Path from "node:path"

import {
  RunEvidencePath,
  RunEvidencePersistence,
  RunEvidencePersistenceErrorCode
} from "@wireio/test-opp-stress"

import {
  allocationDependencies,
  allocationOptions,
  createPersistenceWorkspace
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence reused run destination", () => {
  it("rejects the same deterministic run ID without altering the first run", async () => {
    // Given: one real allocation committed its initializing manifest.
    const workspace = createPersistenceWorkspace()
    try {
      const first = await RunEvidencePersistence.allocate(
          allocationOptions(workspace),
          allocationDependencies()
        ),
        manifestFile = Path.join(first.runDirectory, RunEvidencePath.Manifest),
        manifestBefore = Fs.readFileSync(manifestFile),
        entriesBefore = Fs.readdirSync(first.runDirectory, {
          recursive: true,
          encoding: "utf8"
        })

      // When: the same UUID attempts to allocate the same runs/<runId> directory.
      const duplicate = RunEvidencePersistence.allocate(
        allocationOptions(workspace),
        allocationDependencies()
      )

      // Then: typed persistence authority rejects without mutating first-run bytes.
      await expect(duplicate).rejects.toMatchObject({
        name: "RunEvidencePersistenceError",
        code: RunEvidencePersistenceErrorCode.InvalidState
      })
      expect(Fs.readFileSync(manifestFile)).toEqual(manifestBefore)
      expect(
        Fs.readdirSync(first.runDirectory, {
          recursive: true,
          encoding: "utf8"
        })
      ).toEqual(entriesBefore)
    } finally {
      workspace.cleanup()
    }
  })
})
