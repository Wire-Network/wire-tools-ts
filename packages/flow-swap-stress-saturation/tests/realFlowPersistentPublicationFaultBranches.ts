import Fs from "node:fs"

import { AtomicFile } from "@wireio/debugging-shared"
import {
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceVerificationIssueCode,
  RunEvidenceVerificationVerdict,
  verifyRunEvidence
} from "@wireio/test-opp-stress"
import { runSaturationRamp } from "@wireio/test-flow-swap-stress-saturation"

import type { RealStressFlowLifecycle } from "./real/realFlowLifecycle.js"
import { runningAtomicFaultFixture } from "./realFlowAtomicFaultTestSupport.js"
import { readLifecycleManifest } from "./realFlowLifecycleTestSupport.js"

const Config = {
  initialCount: 1,
  multiplier: 2,
  maxCount: 1,
  phaseTimeoutMs: 30_000
} as const

/** Register persistent iteration and terminal publication failure branches. */
export function registerRealFlowPersistentPublicationFaultBranches(): void {
  describe("real swap stress persistent publication uncertainty", () => {
    it("latches the first persistent iteration failure without a third write", async () => {
      // Given: every immutable iteration link rejects before commit.
      let attempts = 0
      const fixture = await runningAtomicFaultFixture({
          link: async (tempFile, finalFile) => {
            if (!finalFile.includes(`/${RunEvidencePath.Iterations}/`))
              return Fs.promises.link(tempFile, finalFile)
            attempts += 1
            throw new Error("persistent iteration link failed")
          }
        }),
        callbackCause = new Error("callback rejected")
      try {
        // When: controller publication and one legal finalization attempt both fail.
        const firstCause = await rampFailure(fixture.lifecycle, callbackCause)
        const first = fixture.lifecycle.canonicalResult,
          duplicate = await fixture.lifecycle.finalizeInfrastructureFailure(
            new Error("afterAll replacement")
          )

        // Then: the first AtomicFile error/result remains authoritative.
        expect(firstCause).toBeInstanceOf(AtomicFile.PublishError)
        expect(firstCause).toMatchObject({
          committed: false,
          residualTempFile: null,
          finalFile: `${fixture.lifecycle.runDirectory}/iterations/000000.json`
        })
        expect(duplicate).toBe(first)
        expect(first).toMatchObject({
          kind: "fail_closed",
          cause: firstCause,
          publicationError: firstCause,
          preserveCluster: true,
          verification: {
            valid: true,
            verdict: RunEvidenceVerificationVerdict.InProgress,
            lifecycle: RunEvidenceLifecycle.Running
          }
        })
        expect(attempts).toBe(2)
        expect(readLifecycleManifest(fixture.lifecycle.runDirectory)).toMatchObject({
          lifecycle: RunEvidenceLifecycle.Running,
          records: { iterations: [], terminal: null }
        })
      } finally {
        fixture.cleanup()
      }
    })

    it("latches the first persistent terminal failure without a third write", async () => {
      // Given: iteration publication succeeds but every terminal link rejects.
      let attempts = 0
      const fixture = await runningAtomicFaultFixture({
          link: async (tempFile, finalFile) => {
            if (!finalFile.endsWith(RunEvidencePath.Terminal))
              return Fs.promises.link(tempFile, finalFile)
            attempts += 1
            throw new Error("persistent terminal link failed")
          }
        }),
        callbackCause = new Error("callback rejected")
      try {
        // When: controller terminal publication and one finalizer attempt both fail.
        const firstCause = await rampFailure(fixture.lifecycle, callbackCause)
        const first = fixture.lifecycle.canonicalResult,
          duplicate = await fixture.lifecycle.finalizeInfrastructureFailure(
            new Error("afterAll replacement")
          )

        // Then: one declared iteration remains verifier-valid and no terminal exists.
        expect(duplicate).toBe(first)
        expect(firstCause).toMatchObject({
          committed: false,
          residualTempFile: null,
          finalFile: `${fixture.lifecycle.runDirectory}/${RunEvidencePath.Terminal}`
        })
        expect(first).toMatchObject({
          kind: "fail_closed",
          cause: firstCause,
          publicationError: firstCause,
          preserveCluster: true,
          verification: {
            valid: false,
            verdict: RunEvidenceVerificationVerdict.Invalid,
            lifecycle: RunEvidenceLifecycle.Running
          }
        })
        expect(attempts).toBe(2)
        expect(readLifecycleManifest(fixture.lifecycle.runDirectory)).toMatchObject({
          lifecycle: RunEvidenceLifecycle.Running,
          records: { iterations: [{ path: "iterations/000000.json" }], terminal: null }
        })
        const report = verifyRunEvidence(fixture.lifecycle.runDirectory)
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
        fixture.cleanup()
      }
    })
  })
}

async function rampFailure(
  lifecycle: RealStressFlowLifecycle,
  callbackCause: Error
): Promise<unknown> {
  return lifecycle
    .ramp(() =>
      runSaturationRamp({
        persistence: lifecycle.persistence,
        config: Config,
        clock: sequenceClock(103, 104),
        runIteration: () => Promise.reject(callbackCause)
      })
    )
    .then(
      () => null,
      error => error
    )
}

function sequenceClock(...values: readonly number[]): () => number {
  const clock = jest.fn<number, []>()
  values.forEach(value => clock.mockReturnValueOnce(value))
  return clock
}
