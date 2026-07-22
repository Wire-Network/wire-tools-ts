import {
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidenceVerificationVerdict,
  verifyRunEvidence
} from "@wireio/test-opp-stress"
import { runSaturationRamp } from "@wireio/test-flow-swap-stress-saturation"

import { RealStressFlowLifecycle } from "./real/realFlowLifecycle.js"
import {
  createClusterConfig,
  createLifecycleWorkspace,
  lifecycleAllocationDependencies,
  nonSaturatedObservation,
  readLifecycleTerminal
} from "./realFlowLifecycleTestSupport.js"

const Config = {
  initialCount: 1,
  multiplier: 2,
  maxCount: 1,
  phaseTimeoutMs: 30_000
} as const

/** Register returned-versus-persisted terminal authority tests. */
export function registerRealFlowTerminalAuthorityBranches(): void {
  describe("real swap stress terminal authority", () => {
    it("keeps returned and persisted not-saturated authority aligned", async () => {
      // Given: both real artifact-backed phases remain below saturation thresholds.
      const workspace = createLifecycleWorkspace(),
        lifecycle = await runningLifecycle(workspace)
      try {
        const observation = await nonSaturatedObservation(
          workspace,
          lifecycle.persistence
        )

        // When: exact max ends the controller without saturation.
        const result = await lifecycle.ramp(() =>
          runSaturationRamp({
            persistence: lifecycle.persistence,
            config: Config,
            clock: sequenceClock(103, 104),
            runIteration: async () => observation
          })
        )

        // Then: returned status and parsed terminal share one incomplete decision.
        expect(result).toMatchObject({
          status: "saturation_not_reached",
          preserveCluster: true
        })
        expect(readLifecycleTerminal(lifecycle.runDirectory)).toMatchObject({
          lifecycle: RunEvidenceLifecycle.Incomplete,
          preserveCluster: result.preserveCluster,
          missingEndpoints: result.missingEndpoints
        })
        expect(verifyRunEvidence(lifecycle.runDirectory)).toMatchObject({
          valid: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess
        })
      } finally {
        workspace.cleanup()
      }
    })
  })
}

async function runningLifecycle(
  workspace: ReturnType<typeof createLifecycleWorkspace>
): Promise<RealStressFlowLifecycle> {
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
      clock: sequenceClock(101, 102)
    }
  )
  const setup = await lifecycle.setup(async clusterPath => {
    createClusterConfig(workspace)
    return { context: { clusterPath } }
  })
  if (setup.kind !== "succeeded") throw new Error("fixture setup must succeed")
  return lifecycle
}

function sequenceClock(...values: readonly number[]): () => number {
  const clock = jest.fn<number, []>()
  values.forEach(value => clock.mockReturnValueOnce(value))
  return clock
}
