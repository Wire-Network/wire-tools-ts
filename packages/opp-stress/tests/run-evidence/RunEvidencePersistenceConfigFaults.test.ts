import Fs from "node:fs"
import Path from "node:path"

import { AtomicFile } from "@wireio/debugging-shared"
import {
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidencePersistence,
  RunEvidenceVerificationIssueCode,
  RunEvidenceVerificationVerdict,
  parseRunEvidenceManifest,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import {
  allocationDependencies,
  allocationOptions,
  createPersistenceWorkspace,
  failedSetup,
  readJson,
  setupFailedTerminal,
  sha256
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence real AtomicFile config faults", () => {
  it("recovers from a pre-commit link fault with no snapshot claim", async () => {
    // Given: the real publisher fails before linking the config snapshot.
    const workspace = createPersistenceWorkspace(),
      linkCause = new Error("config link failed")
    let failLink = true
    const persistence = await RunEvidencePersistence.allocate(
      allocationOptions(workspace),
      atomicDependencies({
        link: (tempFile, finalFile) =>
          failLink && finalFile.endsWith(RunEvidencePath.ClusterConfigSnapshot)
            ? Promise.reject(linkCause)
            : Fs.promises.link(tempFile, finalFile)
      })
    )
    try {
      // When: exact-byte config capture reaches the failed commit point.
      const error = await captureError(persistence)

      // Then: diagnostics are pre-commit and normal setup failure remains publishable.
      expect(error).toMatchObject({
        stage: AtomicFile.Stage.Link,
        committed: false,
        residualTempFile: null,
        cause: linkCause
      })
      expect(Fs.existsSync(snapshotPath(persistence))).toBe(false)
      failLink = false
      await persistence.publishSetup(failedSetup(false))
      await persistence.publishTerminal(setupFailedTerminal())
      expect(verifyRunEvidence(persistence.runDirectory)).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.NonSuccess,
        lifecycle: RunEvidenceLifecycle.SetupFailed
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("reports committed temp-unlink uncertainty with exact residual bytes", async () => {
    // Given: hard-link commit succeeds but removal of its prepared temp fails.
    const workspace = createPersistenceWorkspace(),
      unlinkCause = new Error("config temp unlink failed"),
      persistence = await RunEvidencePersistence.allocate(
        allocationOptions(workspace),
        atomicDependencies({
          unlink: file =>
            Path.basename(file).startsWith(".cluster-config.snapshot.json.")
              ? Promise.reject(unlinkCause)
              : Fs.promises.unlink(file)
        })
      )
    try {
      // When: actual AtomicFile config publication crosses the commit point.
      const error = await captureError(persistence)

      // Then: committed bytes and residual temp are retained without false rollback.
      expect(error).toMatchObject({
        stage: AtomicFile.Stage.TempUnlink,
        committed: true,
        cause: unlinkCause
      })
      expect(error.residualTempFile).not.toBeNull()
      expect(Fs.readFileSync(snapshotPath(persistence))).toEqual(workspace.configBytes)
      expect(sha256(Fs.readFileSync(snapshotPath(persistence)))).toBe(
        sha256(workspace.configBytes)
      )
      if (error.residualTempFile === null)
        throw new Error("committed unlink fault must retain its temp path")
      expect(Fs.readFileSync(error.residualTempFile)).toEqual(workspace.configBytes)
      await expectFailClosedTopology(persistence, error)
    } finally {
      workspace.cleanup()
    }
  })

  it("reports committed directory-sync uncertainty without a residual temp", async () => {
    // Given: replacement bytes commit and cleanup before parent-directory fsync fails.
    const workspace = createPersistenceWorkspace(),
      syncCause = new Error("config directory sync failed")
    let failDirectorySync = false
    const persistence = await RunEvidencePersistence.allocate(
      allocationOptions(workspace),
      atomicDependencies({
        open: async (file, flags, mode) => {
          const handle = await Fs.promises.open(file, flags, mode)
          return flags === "r" && failDirectorySync
            ? {
                writeFile: handle.writeFile.bind(handle),
                sync: () => Promise.reject(syncCause),
                close: handle.close.bind(handle)
              }
            : handle
        }
      })
    )
    failDirectorySync = true
    try {
      // When: capture reaches the real directory durability operation.
      const error = await captureError(persistence)

      // Then: committed destination is exact and the closed state stays explicit.
      expect(error).toMatchObject({
        stage: AtomicFile.Stage.DirectorySync,
        committed: true,
        residualTempFile: null,
        cause: syncCause
      })
      expect(Fs.readFileSync(snapshotPath(persistence))).toEqual(workspace.configBytes)
      await expectFailClosedTopology(persistence, error)
    } finally {
      workspace.cleanup()
    }
  })
})

function atomicDependencies(
  fileSystem: NonNullable<AtomicFile.Dependencies["fileSystem"]>
): RunEvidencePersistence.Dependencies {
  return {
    ...allocationDependencies(),
    atomicFileDependencies: { fileSystem, tempToken: () => "fault-token" }
  }
}

async function captureError(
  persistence: RunEvidencePersistence
): Promise<AtomicFile.PublishError> {
  try {
    await persistence.captureClusterConfig()
  } catch (error) {
    if (error instanceof AtomicFile.PublishError) return error
    throw error
  }
  throw new Error("config capture must reject")
}

function snapshotPath(persistence: RunEvidencePersistence): string {
  return Path.join(persistence.runDirectory, RunEvidencePath.ClusterConfigSnapshot)
}

async function expectFailClosedTopology(
  persistence: RunEvidencePersistence,
  error: AtomicFile.PublishError
): Promise<void> {
  const parsed = parseRunEvidenceManifest(
      readJson(Path.join(persistence.runDirectory, RunEvidencePath.Manifest))
    ),
    report = verifyRunEvidence(persistence.runDirectory)
  expect("value" in parsed ? parsed.value.lifecycle : null).toBe(
    RunEvidenceLifecycle.Initializing
  )
  expect(Fs.existsSync(Path.join(persistence.runDirectory, RunEvidencePath.Setup))).toBe(false)
  expect(Fs.existsSync(Path.join(persistence.runDirectory, RunEvidencePath.Terminal))).toBe(false)
  expect(report).toMatchObject({
    valid: false,
    verdict: RunEvidenceVerificationVerdict.Invalid
  })
  expect(report.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: RunEvidenceVerificationIssueCode.ExtraEntry })
    ])
  )
  await expect(persistence.captureClusterConfig()).rejects.toBe(error)
}
