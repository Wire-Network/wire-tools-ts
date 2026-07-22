import Fs from "node:fs"

import { AtomicFile } from "@wireio/debugging-shared"
import {
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidencePath,
  RunEvidenceVerificationVerdict,
  verifyRunEvidence,
  type RunEvidencePersistence
} from "@wireio/test-opp-stress"
import { runSaturationRamp } from "@wireio/test-flow-swap-stress-saturation"

import { RealStressFlowLifecycle } from "./real/realFlowLifecycle.js"
import {
  createClusterConfig,
  createLifecycleWorkspace,
  lifecycleAllocationDependencies,
  readLifecycleManifest
} from "./realFlowLifecycleTestSupport.js"

const Config = {
  initialCount: 1,
  multiplier: 2,
  maxCount: 1,
  phaseTimeoutMs: 30_000
} as const

/** Register normal-exit and fail-closed lifecycle regression tests. */
export function registerRealFlowExitLifecycleBranches(): void {
  describe("real swap stress normal exit lifecycle", () => {
    it("finalizes a liveness rejection before afterAll cleanup", async () => {
      // Given: setup succeeded but the liveness assertion rejects before ramp.
      const fixture = await runningFixture(),
        cause = new Error("WIRE liveness assertion failed")
      try {
        // When: the suite executes liveness through the lifecycle guard.
        await expect(
          fixture.lifecycle.runGuarded(() => Promise.reject(cause))
        ).rejects.toBe(cause)
        const first = fixture.lifecycle.canonicalResult,
          second = await fixture.lifecycle.finalizeInfrastructureFailure(
            new Error("afterAll duplicate")
          )

        // Then: afterAll observes one terminal decision retaining the first cause.
        expect(second).toBe(first)
        expect(second).toMatchObject({ cause, preserveCluster: true })
        expect(verifyRunEvidence(fixture.lifecycle.runDirectory)).toMatchObject({
          valid: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess,
          lifecycle: RunEvidenceLifecycle.Failed
        })
      } finally {
        fixture.cleanup()
      }
    })

    it("finalizes a ramp wrapper rejection before rethrowing it", async () => {
      // Given: setup is running and the wrapper rejects outside generic classification.
      const fixture = await runningFixture(),
        cause = new Error("ramp wrapper rejected")
      try {
        // When: RealStressFlowLifecycle owns the wrapper boundary.
        await expect(
          fixture.lifecycle.ramp(() => Promise.reject(cause))
        ).rejects.toBe(cause)

        // Then: persisted and in-memory lifecycle retain the infrastructure exit.
        expect(fixture.lifecycle.canonicalResult).toMatchObject({
          cause,
          preserveCluster: true
        })
        expect(verifyRunEvidence(fixture.lifecycle.runDirectory)).toMatchObject({
          valid: true,
          lifecycle: RunEvidenceLifecycle.Failed
        })
      } finally {
        fixture.cleanup()
      }
    })

    it("repairs a pre-commit ramp publication fault through OPP authority", async () => {
      // Given: the first immutable iteration link fails before commitment exactly once.
      let failIterationLink = true
      const fixture = await runningFixture({
          link: (tempFile, finalFile) => {
            if (
              failIterationLink &&
              finalFile.includes(`/${RunEvidencePath.Iterations}/`)
            ) {
              failIterationLink = false
              return Promise.reject(new Error("iteration link failed"))
            }
            return Fs.promises.link(tempFile, finalFile)
          }
        }),
        callbackCause = new Error("callback rejected")
      try {
        // When: generic publication rejects and the lifecycle finalizer takes over.
        const publicationCause = await fixture.lifecycle
          .ramp(() =>
            runSaturationRamp({
              persistence: fixture.lifecycle.persistence,
              config: Config,
              clock: sequenceClock(103, 104),
              runIteration: () => Promise.reject(callbackCause)
            })
          )
          .then(
            () => null,
            error => error
          )

        // Then: the publication cause is rethrown and also owns canonical finalization.
        expect(publicationCause).toBeInstanceOf(AtomicFile.PublishError)
        expect(fixture.lifecycle.canonicalResult).toMatchObject({
          cause: publicationCause,
          preserveCluster: true
        })
        expect(verifyRunEvidence(fixture.lifecycle.runDirectory)).toMatchObject({
          valid: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess
        })
      } finally {
        fixture.cleanup()
      }
    })

    it("exposes manifest uncertainty as canonical fail-closed state", async () => {
      // Given: a breakage iteration commits before its running-manifest rename fails.
      let failManifest = false
      const fixture = await runningFixture({
          rename: (tempFile, finalFile) =>
            failManifest && finalFile.endsWith(RunEvidencePath.Manifest)
              ? Promise.reject(new Error("manifest rename failed"))
              : Fs.promises.rename(tempFile, finalFile)
        }),
        callbackCause = new Error("callback rejected")
      failManifest = true
      try {
        // When: finalization sees persistence already closed by atomic uncertainty.
        await expect(
          fixture.lifecycle.ramp(() =>
            runSaturationRamp({
              persistence: fixture.lifecycle.persistence,
              config: Config,
              clock: sequenceClock(103, 104),
              runIteration: () => Promise.reject(callbackCause)
            })
          )
        ).rejects.toBeInstanceOf(AtomicFile.PublishError)
        const first = fixture.lifecycle.canonicalResult,
          second = await fixture.lifecycle.finalizeInfrastructureFailure(
            new Error("afterAll duplicate")
          )

        // Then: no false terminal is fabricated and afterAll sees the same closed state.
        expect(first).toBe(second)
        expect(first).toMatchObject({
          kind: "fail_closed",
          preserveCluster: true,
          lifecycle: RunEvidenceLifecycle.Running
        })
        expect(readLifecycleManifest(fixture.lifecycle.runDirectory)).toMatchObject({
          lifecycle: RunEvidenceLifecycle.Running,
          records: { terminal: null }
        })
        expect(verifyRunEvidence(fixture.lifecycle.runDirectory)).toMatchObject({
          valid: false,
          verdict: RunEvidenceVerificationVerdict.Invalid
        })
      } finally {
        fixture.cleanup()
      }
    })
  })
}

async function runningFixture(
  fileSystem: NonNullable<AtomicFile.Dependencies["fileSystem"]> = {}
) {
  const workspace = createLifecycleWorkspace(),
    persistence: RunEvidencePersistence.Dependencies = {
      ...lifecycleAllocationDependencies(),
      atomicFileDependencies: { fileSystem }
    },
    lifecycle = await RealStressFlowLifecycle.allocate(
      {
        clusterPath: workspace.clusterPath,
        rampConfig: Config,
        provenance: {
          wireBuildPath: "/wire-build",
          ethereumPath: "/wire-ethereum",
          solanaPath: "/wire-solana"
        },
        requiredEndpoints: [
          RunEvidenceEndpoint.OutpostEthereumDepot,
          RunEvidenceEndpoint.DepotOutpostEthereum
        ],
        startedAtMs: "100"
      },
      { persistence, clock: sequenceClock(101, 102, 105, 106) }
    )
  const setup = await lifecycle.setup(async clusterPath => {
    createClusterConfig(workspace)
    return { context: { clusterPath } }
  })
  if (setup.kind !== "succeeded") throw new Error("fixture setup must succeed")
  return { lifecycle, cleanup: workspace.cleanup }
}

function sequenceClock(...values: readonly number[]): () => number {
  const clock = jest.fn<number, []>()
  values.forEach(value => clock.mockReturnValueOnce(value))
  return clock
}
