import Fs from "node:fs"
import Path from "node:path"

import { AtomicFile } from "@wireio/debugging-shared"
import {
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceVerificationIssueCode,
  RunEvidenceVerificationVerdict,
  parseRunEvidenceManifest,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { allocateAtomicFaultLifecycle } from "./realFlowAtomicFaultTestSupport.js"
import {
  createClusterConfig,
  createLifecycleWorkspace,
  readLifecycleManifest
} from "./realFlowLifecycleTestSupport.js"

/** Register real AtomicFile config-capture lifecycle faults. */
export function registerRealFlowConfigFaultBranches(): void {
  describe("real swap stress config publication lifecycle", () => {
    it("fails closed on a pre-commit config snapshot failure", async () => {
      // Given: setup creates config but its immutable hard-link fails before commit.
      const workspace = createLifecycleWorkspace(),
        linkCause = new Error("config link failed"),
        lifecycle = await allocateAtomicFaultLifecycle({
          workspace,
          fileSystem: {
            link: (tempFile, finalFile) =>
              finalFile.endsWith(RunEvidencePath.ClusterConfigSnapshot)
                ? Promise.reject(linkCause)
                : Fs.promises.link(tempFile, finalFile)
          }
        })
      try {
        // When: setup reaches real captureClusterConfig publication.
        const outcome = await lifecycle.setup(async clusterPath => {
          createClusterConfig(workspace)
          return { context: { clusterPath } }
        })

        // Then: source existence is retained without an unavailable or terminal claim.
        expect(outcome).toMatchObject({
          kind: "failed",
          cause: {
            stage: AtomicFile.Stage.Link,
            committed: false,
            residualTempFile: null,
            finalFile: Path.join(
              lifecycle.runDirectory,
              RunEvidencePath.ClusterConfigSnapshot
            ),
            cause: linkCause
          },
          result: {
            kind: "fail_closed",
            preserveCluster: true,
            sourceConfigExists: true,
            evidenceDirectory: lifecycle.runDirectory,
            verification: {
              valid: true,
              verdict: RunEvidenceVerificationVerdict.InProgress,
              lifecycle: RunEvidenceLifecycle.Initializing
            }
          }
        })
        expect(
          Fs.existsSync(
            Path.join(lifecycle.runDirectory, RunEvidencePath.ClusterConfigSnapshot)
          )
        ).toBe(false)
        expect(readLifecycleManifest(lifecycle.runDirectory)).toMatchObject({
          lifecycle: RunEvidenceLifecycle.Initializing,
          clusterConfigSnapshot: { kind: "pending" },
          records: { setup: { kind: "pending" }, terminal: null }
        })
        expect(verifyRunEvidence(lifecycle.runDirectory)).toMatchObject({
          valid: true,
          verdict: RunEvidenceVerificationVerdict.InProgress,
          lifecycle: RunEvidenceLifecycle.Initializing
        })
      } finally {
        workspace.cleanup()
      }
    })

    it("exposes committed config temp-unlink uncertainty without rollback", async () => {
      // Given: config snapshot links before its prepared temp cannot be removed.
      const workspace = createLifecycleWorkspace(),
        unlinkCause = new Error("config temp unlink failed"),
        lifecycle = await allocateAtomicFaultLifecycle({
          workspace,
          fileSystem: {
            unlink: file =>
              Path.basename(file).startsWith(".cluster-config.snapshot.json.")
                ? Promise.reject(unlinkCause)
                : Fs.promises.unlink(file)
          }
        })
      try {
        // When: setup crosses the immutable config commit point.
        const outcome = await lifecycle.setup(async clusterPath => {
          createClusterConfig(workspace)
          return { context: { clusterPath } }
        })

        // Then: fail-closed state exposes committed diagnostics and exact bytes.
        expect(outcome).toMatchObject({
          kind: "failed",
          cause: {
            stage: AtomicFile.Stage.TempUnlink,
            committed: true,
            cause: unlinkCause
          },
          result: {
            kind: "fail_closed",
            lifecycle: RunEvidenceLifecycle.Initializing,
            preserveCluster: true
          }
        })
        if (outcome.kind !== "failed") throw new Error("capture fault must fail")
        if (!(outcome.cause instanceof AtomicFile.PublishError))
          throw new Error("AtomicFile failure expected")
        expect(outcome.cause.residualTempFile).not.toBeNull()
        expect(
          Fs.readFileSync(
            Path.join(lifecycle.runDirectory, RunEvidencePath.ClusterConfigSnapshot)
          )
        ).toEqual(Fs.readFileSync(workspace.configPath))
        expect(parseRunEvidenceManifest(readLifecycleManifest(lifecycle.runDirectory))).toHaveProperty("value")
        expect(
          Fs.existsSync(Path.join(lifecycle.runDirectory, RunEvidencePath.Setup))
        ).toBe(false)
        expect(
          Fs.existsSync(Path.join(lifecycle.runDirectory, RunEvidencePath.Terminal))
        ).toBe(false)
        const report = verifyRunEvidence(lifecycle.runDirectory)
        expect(report).toMatchObject({
          valid: false,
          verdict: RunEvidenceVerificationVerdict.Invalid,
          lifecycle: RunEvidenceLifecycle.Initializing
        })
        expect(report.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: RunEvidenceVerificationIssueCode.ExtraEntry
            })
          ])
        )
      } finally {
        workspace.cleanup()
      }
    })
  })
}
