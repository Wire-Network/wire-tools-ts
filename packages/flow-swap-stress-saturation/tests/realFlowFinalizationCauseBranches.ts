import { AtomicFile } from "@wireio/debugging-shared"
import {
  RunEvidenceEndpoint,
  RunEvidenceLifecycle
} from "@wireio/test-opp-stress"

import { RealStressFlowLifecycle } from "./real/realFlowLifecycle.js"
import {
  createClusterConfig,
  createLifecycleWorkspace,
  lifecycleAllocationDependencies
} from "./realFlowLifecycleTestSupport.js"

const Config = {
  initialCount: 1,
  multiplier: 2,
  maxCount: 1,
  phaseTimeoutMs: 30_000
} as const

/** Register persistence-finalization cause authority and idempotence tests. */
export function registerRealFlowFinalizationCauseBranches(): void {
  describe("real swap stress finalization cause authority", () => {
    it("retains a rejected AtomicFile finalization cause in canonical diagnostics", async () => {
      // Given: persistence rejects with committed publication diagnostics distinct from the operation failure.
      const fixture = await runningFixture(),
        operationCause = new Error("guarded operation failed"),
        finalizationCause = publishError("rejected-finalization.tmp"),
        finalize = jest
          .spyOn(fixture.lifecycle.persistence, "finalizeInfrastructureFailure")
          .mockRejectedValue(finalizationCause)
      try {
        // When: the lifecycle settles persistence finalization fail-closed.
        const result = await fixture.lifecycle.finalizeInfrastructureFailure(
          operationCause
        )

        // Then: the finalization failure, including committed and residual state, is authoritative.
        expect(result).toMatchObject({
          kind: "fail_closed",
          cause: finalizationCause,
          publicationError: finalizationCause,
          preserveCluster: true
        })
        expect(result).not.toMatchObject({ cause: operationCause })
        expect(result).toBe(fixture.lifecycle.canonicalResult)
        if (!("kind" in result) || result.kind !== "fail_closed")
          throw new Error("rejected finalization must fail closed")
        expect(result.cause).toBe(finalizationCause)
        expect(result.cause).not.toBe(operationCause)
        expect(result.publicationError).toBe(finalizationCause)
        expect(result.publicationError).toMatchObject({
          committed: true,
          residualTempFile: "/evidence/rejected-finalization.tmp"
        })
        expect(finalize).toHaveBeenCalledTimes(1)
      } finally {
        fixture.cleanup()
      }
    })

    it("retains a returned fail-closed finalization cause in canonical diagnostics", async () => {
      // Given: persistence returns a fail-closed cause distinct from the operation failure.
      const fixture = await runningFixture(),
        operationCause = new Error("suite operation failed"),
        finalizationCause = publishError("returned-finalization.tmp"),
        finalize = jest
          .spyOn(fixture.lifecycle.persistence, "finalizeInfrastructureFailure")
          .mockResolvedValue({
            kind: "fail_closed",
            lifecycle: RunEvidenceLifecycle.Running,
            preserveCluster: true,
            cause: finalizationCause
          })
      try {
        // When: the lifecycle receives persistence's explicit fail-closed decision.
        const result = await fixture.lifecycle.finalizeInfrastructureFailure(
          operationCause
        )

        // Then: canonical diagnostics retain persistence's actual publication cause.
        expect(result).toMatchObject({
          kind: "fail_closed",
          cause: finalizationCause,
          publicationError: finalizationCause,
          preserveCluster: true
        })
        expect(result).not.toMatchObject({ cause: operationCause })
        expect(result).toBe(fixture.lifecycle.canonicalResult)
        if (!("kind" in result) || result.kind !== "fail_closed")
          throw new Error("returned finalization must fail closed")
        expect(result.cause).toBe(finalizationCause)
        expect(result.cause).not.toBe(operationCause)
        expect(result.publicationError).toBe(finalizationCause)
        expect(result.publicationError).toMatchObject({
          committed: true,
          residualTempFile: "/evidence/returned-finalization.tmp"
        })
        expect(finalize).toHaveBeenCalledTimes(1)
      } finally {
        fixture.cleanup()
      }
    })

    it("retains the operation cause after successful terminalization and writes once", async () => {
      // Given: a running lifecycle can persist one terminal infrastructure failure.
      const fixture = await runningFixture(),
        operationCause = new Error("successful terminalization cause"),
        finalize = jest.spyOn(
          fixture.lifecycle.persistence,
          "finalizeInfrastructureFailure"
        )
      try {
        // When: finalization succeeds and afterAll requests finalization again.
        const first = await fixture.lifecycle.finalizeInfrastructureFailure(
            operationCause
          ),
          second = await fixture.lifecycle.finalizeInfrastructureFailure(
            new Error("duplicate finalization cause")
          )

        // Then: the first result and operation cause remain canonical without another persistence write.
        expect(first).toMatchObject({
          kind: "terminalized",
          cause: operationCause,
          preserveCluster: true
        })
        expect(second).toBe(first)
        expect(first).toBe(fixture.lifecycle.canonicalResult)
        if (!("kind" in first) || first.kind !== "terminalized")
          throw new Error("successful finalization must terminalize")
        expect(first.cause).toBe(operationCause)
        expect(finalize).toHaveBeenCalledTimes(1)
        expect(finalize).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: operationCause.message,
            cause: operationCause
          })
        )
      } finally {
        fixture.cleanup()
      }
    })
  })
}

async function runningFixture() {
  const workspace = createLifecycleWorkspace(),
    clock = jest.fn<number, []>()
  Array.of(101, 102, 103).forEach(value => clock.mockReturnValueOnce(value))
  const lifecycle = await RealStressFlowLifecycle.allocate(
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
      {
        persistence: lifecycleAllocationDependencies(),
        clock
      }
    )
  const setup = await lifecycle.setup(async clusterPath => {
    createClusterConfig(workspace)
    return { context: { clusterPath } }
  })
  if (setup.kind !== "succeeded") throw new Error("fixture setup must succeed")
  return { lifecycle, cleanup: workspace.cleanup }
}

function publishError(residualName: string): AtomicFile.PublishError {
  return new AtomicFile.PublishError({
    stage: AtomicFile.Stage.TempUnlink,
    finalFile: "/evidence/terminal.json",
    committed: true,
    residualTempFile: `/evidence/${residualName}`,
    cause: new Error("atomic finalization publication failed")
  })
}
