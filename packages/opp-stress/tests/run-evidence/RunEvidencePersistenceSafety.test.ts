import Fs from "node:fs"
import Path from "node:path"

import {
  RunEvidencePath,
  RunEvidencePersistence
} from "@wireio/test-opp-stress"

import {
  allocateRunningPersistence,
  allocationDependencies,
  allocationOptions,
  artifactCapture,
  createPersistenceWorkspace,
  readJson,
  writeOppPair
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence filesystem safety", () => {
  it.each(["../escape", "..\\escape", "/absolute/override"])(
    "rejects unsafe base-key override %s",
    async baseKey => {
      // Given: a running persistence with no artifact entries.
      const workspace = createPersistenceWorkspace()
      try {
        const persistence = await allocateRunningPersistence(workspace)
        // When/Then: traversal, backslash, and absolute overrides fail before I/O.
        await expect(
          persistence.beginObservation("103").captureArtifact({
            baseKey,
            dataBytes: Buffer.from("data"),
            metadataBytes: Buffer.from("metadata")
          })
        ).rejects.toMatchObject({ name: "RunEvidencePersistenceError" })
        expect(
          readJson(
            Path.join(persistence.runDirectory, RunEvidencePath.Manifest)
          )
        ).toMatchObject({
          artifacts: []
        })
      } finally {
        workspace.cleanup()
      }
    }
  )

  it("rejects malformed supplied bytes without consulting source files", async () => {
    // Given: one canonical key whose source is removed after exact bytes are captured.
    const workspace = createPersistenceWorkspace()
    try {
      const persistence = await allocateRunningPersistence(workspace),
        baseKey = writeOppPair(workspace.oppRoot, ["operator.a"]),
        valid = artifactCapture(workspace.oppRoot, baseKey)
      Fs.rmSync(workspace.oppRoot, { recursive: true })
      // When/Then: malformed metadata and data snapshots are independently rejected.
      await expect(
        persistence.beginObservation("103").captureArtifact({
          ...valid,
          metadataBytes: Buffer.from([0xff])
        })
      ).rejects.toMatchObject({ name: "RunEvidencePersistenceError" })
      await expect(
        persistence.beginObservation("104").captureArtifact({
          ...valid,
          dataBytes: Buffer.from("changed")
        })
      ).rejects.toMatchObject({ name: "RunEvidencePersistenceError" })
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects a symlinked config path before immutable capture", async () => {
    // Given: cluster-config.json is a symlink to bytes outside the cluster root.
    const workspace = createPersistenceWorkspace(),
      configFile = Path.join(workspace.clusterPath, "cluster-config.json"),
      outside = Path.join(workspace.root, "outside-config.json")
    Fs.renameSync(configFile, outside)
    Fs.symlinkSync(outside, configFile)
    try {
      const persistence = await RunEvidencePersistence.allocate(
        allocationOptions(workspace),
        allocationDependencies()
      )
      // When/Then: fixed config capture rejects every symlink component.
      await expect(persistence.captureClusterConfig()).rejects.toMatchObject({
        name: "RunEvidencePersistenceError"
      })
      expect(
        Fs.existsSync(
          Path.join(
            persistence.runDirectory,
            RunEvidencePath.ClusterConfigSnapshot
          )
        )
      ).toBe(false)
    } finally {
      workspace.cleanup()
    }
  })

  it("does not invoke source filesystem hooks during artifact capture", async () => {
    // Given: exact bytes are prepared before installing an artifact-read tripwire.
    const workspace = createPersistenceWorkspace(),
      baseKey = writeOppPair(workspace.oppRoot, ["operator.a"]),
      request = artifactCapture(workspace.oppRoot, baseKey),
      persistence = await allocateRunningPersistence(
        workspace,
        allocationDependencies({
          open: (file, flags) => {
            if (file.endsWith(".data") || file.endsWith(".metadata"))
              throw new Error("artifact source read attempted")
            return Fs.promises.open(file, flags)
          }
        })
      )
    try {
      // When: persistence captures only the supplied snapshot.
      const refs = await persistence
        .beginObservation("103")
        .captureArtifact(request)
      // Then: exact immutable files publish without tripping source I/O.
      expect(
        Fs.existsSync(Path.join(persistence.runDirectory, refs.data.path))
      ).toBe(true)
    } finally {
      workspace.cleanup()
    }
  })
})
