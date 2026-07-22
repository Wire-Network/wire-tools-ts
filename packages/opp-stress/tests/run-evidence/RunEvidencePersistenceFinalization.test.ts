import Fs from "node:fs"

import { AtomicFile } from "@wireio/debugging-shared"
import {
  RampBreakageCategory,
  RunEvidenceIterationOutcome,
  RunEvidenceLifecycle,
  RunEvidenceVerificationIssueCode,
  RunEvidenceVerificationVerdict,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import {
  allocationDependencies,
  allocateRunningPersistence,
  breakageIteration,
  createPersistenceWorkspace,
} from "./runEvidencePersistenceTestSupport.js"

describe("RunEvidencePersistence infrastructure finalization", () => {
  it("terminalizes a running setup with no workload iteration", async () => {
    // Given: successful setup entered the running lifecycle before a liveness check failed.
    const workspace = createPersistenceWorkspace(),
      persistence = await allocateRunningPersistence(workspace),
      cause = new Error("WIRE liveness assertion failed")
    try {
      // When: the lifecycle asks persistence to finalize the infrastructure exit.
      const result = await persistence.finalizeInfrastructureFailure({
        endedAtMs: "103",
        reason: cause.message,
        cause
      })

      // Then: one canonical breakage iteration and terminal retain the exact cause.
      expect(result).toMatchObject({
        kind: "terminalized",
        lifecycle: RunEvidenceLifecycle.Failed,
        preserveCluster: true,
        breakageCategory: RampBreakageCategory.Infrastructure,
        breakageReason: cause.message,
        cause
      })
      if (result.kind !== "terminalized")
        throw new Error("running setup must terminalize")
      expect(result.iteration.outcome).toBe(RunEvidenceIterationOutcome.Breakage)
      expect(verifyRunEvidence(persistence.runDirectory)).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.NonSuccess,
        lifecycle: RunEvidenceLifecycle.Failed
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("reuses an existing breakage iteration and finalizes idempotently", async () => {
    // Given: controller breakage committed before terminal publication failed.
    const workspace = createPersistenceWorkspace(),
      persistence = await allocateRunningPersistence(workspace),
      firstRef = await persistence.publishIteration(breakageIteration(0)),
      cause = new Error("ramp wrapper rejected")
    try {
      // When: normal cleanup requests finalization twice for the same exit.
      const first = await persistence.finalizeInfrastructureFailure({
          endedAtMs: "105",
          reason: cause.message,
          cause
        }),
        second = await persistence.finalizeInfrastructureFailure({
          endedAtMs: "999",
          reason: "afterAll duplicate",
          cause: new Error("duplicate")
        })

      // Then: the first decision is authoritative and no second terminal is written.
      expect(second).toBe(first)
      if (first.kind !== "terminalized")
        throw new Error("running iteration must terminalize")
      expect(first.iteration.iterationIndex).toBe(0)
      expect(first.terminal.iterationRefs[0]).toEqual(firstRef)
      expect(first.terminal.iterationRefs).toHaveLength(1)
      expect(first.cause).toBe(cause)
      const report = verifyRunEvidence(persistence.runDirectory)
      expect(report.issues).toEqual([])
      expect(report).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.NonSuccess
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("latches a persistent pre-commit iteration failure", async () => {
    // Given: successful setup is running and every iteration hard-link fails.
    const workspace = createPersistenceWorkspace()
    let attempts = 0
    const persistence = await allocateRunningPersistence(workspace, {
        ...allocationDependencies(),
        atomicFileDependencies: {
          fileSystem: {
            link: async (tempFile, finalFile) => {
              if (!finalFile.includes("/iterations/"))
                return Fs.promises.link(tempFile, finalFile)
              attempts += 1
              throw new Error("persistent iteration link failed")
            }
          }
        }
      }),
      cause = new Error("liveness failed")
    try {
      // When: finalization is requested twice after persistent publication failure.
      const first = await persistence.finalizeInfrastructureFailure({
          endedAtMs: "103",
          reason: cause.message,
          cause
        }),
        second = await persistence.finalizeInfrastructureFailure({
          endedAtMs: "104",
          reason: "replacement",
          cause: new Error("replacement")
        })

      // Then: one AtomicFile error closes publication and the same result is reused.
      expect(first.kind).toBe("fail_closed")
      if (first.kind !== "fail_closed") throw new Error("fault must fail closed")
      expect(first.cause).toMatchObject({
        stage: AtomicFile.Stage.Link,
        committed: false,
        residualTempFile: null
      })
      expect(second).toBe(first)
      expect(attempts).toBe(1)
      expect(verifyRunEvidence(persistence.runDirectory)).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.InProgress,
        lifecycle: RunEvidenceLifecycle.Running
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("latches a persistent pre-commit terminal failure", async () => {
    // Given: a declared breakage iteration exists and every terminal link fails.
    const workspace = createPersistenceWorkspace()
    let attempts = 0
    const persistence = await allocateRunningPersistence(workspace, {
      ...allocationDependencies(),
      atomicFileDependencies: {
        fileSystem: {
          link: async (tempFile, finalFile) => {
            if (!finalFile.endsWith("terminal.json"))
              return Fs.promises.link(tempFile, finalFile)
            attempts += 1
            throw new Error("persistent terminal link failed")
          }
        }
      }
    })
    await persistence.publishIteration(breakageIteration(0))
    try {
      // When: finalization is requested repeatedly.
      const first = await persistence.finalizeInfrastructureFailure({
          endedAtMs: "105",
          reason: "terminal publication failed",
          cause: new Error("controller terminal failure")
        }),
        second = await persistence.finalizeInfrastructureFailure({
          endedAtMs: "106",
          reason: "replacement",
          cause: new Error("replacement")
        })

      // Then: no terminal is fabricated and the first fail-closed result is stable.
      expect(first).toMatchObject({
        kind: "fail_closed",
        cause: {
          stage: AtomicFile.Stage.Link,
          committed: false,
          residualTempFile: null
        }
      })
      expect(second).toBe(first)
      expect(attempts).toBe(1)
      const report = verifyRunEvidence(persistence.runDirectory)
      expect(report).toMatchObject({
        valid: false,
        verdict: RunEvidenceVerificationVerdict.Invalid,
        lifecycle: RunEvidenceLifecycle.Running
      })
      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: RunEvidenceVerificationIssueCode.LifecycleMismatch
          })
        ])
      )
    } finally {
      workspace.cleanup()
    }
  })
})
