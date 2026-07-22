import Fs from "node:fs"
import Path from "node:path"

import { AtomicFile } from "@wireio/debugging-shared"
import {
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceVerificationIssueCode,
  RunEvidenceVerificationVerdict,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { allocateAtomicFaultLifecycle } from "./realFlowAtomicFaultTestSupport.js"
import {
  createClusterConfig,
  createLifecycleWorkspace,
  readLifecycleManifest
} from "./realFlowLifecycleTestSupport.js"

type SetupFaultCase = {
  readonly label: string
  readonly stage: AtomicFile.Stage
  readonly fileSystem: (
    recordAttempt: () => void
  ) => NonNullable<AtomicFile.Dependencies["fileSystem"]>
}

const SetupFaultCases: readonly SetupFaultCase[] = [
  {
    label: "temp write",
    stage: AtomicFile.Stage.TempWrite,
    fileSystem: recordAttempt => ({
      open: async (file, flags, mode) => {
        const handle = await Fs.promises.open(file, flags, mode)
        if (flags !== "wx" || !file.includes(".setup.json.")) return handle
        return {
          writeFile: async () => {
            recordAttempt()
            throw new Error("setup temp write failed")
          },
          sync: handle.sync.bind(handle),
          close: handle.close.bind(handle)
        }
      }
    })
  },
  {
    label: "file sync",
    stage: AtomicFile.Stage.FileSync,
    fileSystem: recordAttempt => ({
      open: async (file, flags, mode) => {
        const handle = await Fs.promises.open(file, flags, mode)
        if (flags !== "wx" || !file.includes(".setup.json.")) return handle
        return {
          writeFile: handle.writeFile.bind(handle),
          sync: async () => {
            recordAttempt()
            throw new Error("setup file sync failed")
          },
          close: handle.close.bind(handle)
        }
      }
    })
  },
  {
    label: "link",
    stage: AtomicFile.Stage.Link,
    fileSystem: recordAttempt => ({
      link: async (tempFile, finalFile) => {
        if (!finalFile.endsWith(RunEvidencePath.Setup))
          return Fs.promises.link(tempFile, finalFile)
        recordAttempt()
        throw new Error("setup link failed")
      }
    })
  }
]

/** Register successful-setup record publication uncertainty branches. */
export function registerRealFlowSetupPublicationFaultBranches(): void {
  describe("real swap stress setup publication uncertainty", () => {
    it.each(SetupFaultCases)(
      "settles $label failure once without attempting an iteration",
      async fault => {
        // Given: config capture commits before setup.json fails pre-commit.
        const workspace = createLifecycleWorkspace()
        let attempts = 0
        const lifecycle = await allocateAtomicFaultLifecycle({
          workspace,
          fileSystem: fault.fileSystem(() => {
            attempts += 1
          })
        })
        try {
          // When: successful setup reaches the real AtomicFile publication.
          const outcome = await lifecycle.setup(async clusterPath => {
            createClusterConfig(workspace)
            return { context: { clusterPath } }
          })

          // Then: afterAll reuses one explicit fail-closed result and first cause.
          expect(outcome.kind).toBe("failed")
          if (outcome.kind !== "failed") throw new Error("setup fault must fail")
          expect(outcome.cause).toMatchObject({
            stage: fault.stage,
            committed: false,
            residualTempFile: null,
            finalFile: Path.join(lifecycle.runDirectory, RunEvidencePath.Setup)
          })
          const duplicate = await lifecycle.finalizeInfrastructureFailure(
            new Error("afterAll replacement")
          )
          expect(duplicate).toBe(outcome.result)
          expect(duplicate).toMatchObject({
            kind: "fail_closed",
            cause: outcome.cause,
            publicationError: outcome.cause,
            evidenceDirectory: lifecycle.runDirectory,
            sourceConfigExists: true,
            preserveCluster: true,
            verification: {
              valid: false,
              verdict: RunEvidenceVerificationVerdict.Invalid,
              lifecycle: RunEvidenceLifecycle.Initializing
            }
          })
          expect(attempts).toBe(1)
          expect(readLifecycleManifest(lifecycle.runDirectory)).toMatchObject({
            lifecycle: RunEvidenceLifecycle.Initializing,
            clusterConfigSnapshot: { kind: "pending" },
            records: { setup: { kind: "pending" }, iterations: [], terminal: null }
          })
          expect(
            Fs.existsSync(Path.join(lifecycle.runDirectory, RunEvidencePath.Setup))
          ).toBe(false)
          expect(
            Fs.existsSync(Path.join(lifecycle.runDirectory, RunEvidencePath.Terminal))
          ).toBe(false)
          const report = verifyRunEvidence(lifecycle.runDirectory)
          expect(report.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ code: RunEvidenceVerificationIssueCode.ExtraEntry })
            ])
          )
        } finally {
          workspace.cleanup()
        }
      }
    )
  })
}
