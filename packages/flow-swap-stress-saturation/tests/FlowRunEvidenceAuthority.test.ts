import {
  RampBreakageCategory,
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
  readLifecycleManifest,
  readLifecycleTerminal
} from "./realFlowLifecycleTestSupport.js"
import type { SwapStressIterationObservation } from "@wireio/test-flow-swap-stress-saturation"

const Config = {
    initialCount: 1,
    multiplier: 2,
    maxCount: 1,
    phaseTimeoutMs: 30_000
  } as const,
  WorkloadReason = "phase-1 quote produced zero target"

describe("persisted flow controller authority", () => {
  it("preserves an empty-phase workload breakage without inventing telemetry", async () => {
    // Given: the reachable impossible-quote outcome has no measured phase evidence.
    const fixture = await runningFixture(),
      observation = workloadObservation([])
    try {
      // When: the flow observation crosses the adapter and generic controller.
      const result = await fixture.lifecycle.ramp(() =>
        runSaturationRamp({
          persistence: fixture.lifecycle.persistence,
          config: Config,
          clock: sequenceClock(103, 104),
          runIteration: async () => observation
        })
      )

      // Then: workload category, reason, and original observation survive canonically.
      expect(result.iterations[0]).toMatchObject({
        observation,
        breakageCategory: RampBreakageCategory.Workload,
        breakageReason: WorkloadReason
      })
      const iteration = result.iterations[0]
      if (iteration?.kind !== "breakage")
        throw new Error("workload result must be breakage")
      expect(readLifecycleManifest(fixture.lifecycle.runDirectory)).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Failed,
        telemetry: { kind: "empty" }
      })
      expect(readLifecycleTerminal(fixture.lifecycle.runDirectory)).toMatchObject({
        breakageCategory: iteration.breakageCategory,
        breakageReason: iteration.breakageReason
      })
      expect(verifyRunEvidence(fixture.lifecycle.runDirectory)).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.NonSuccess
      })
    } finally {
      fixture.cleanup()
    }
  })

  it("uses generic InvalidObservation instead of a cached original root claim", async () => {
    // Given: the callback claims saturation unsupported by its empty phase payload.
    const fixture = await runningFixture(),
      observation = workloadObservation([
        RunEvidenceEndpoint.OutpostEthereumDepot
      ])
    try {
      // When: schema parsing rejects the adapter result after the wrapper cached it.
      const result = await fixture.lifecycle.ramp(() =>
        runSaturationRamp({
          persistence: fixture.lifecycle.persistence,
          config: Config,
          clock: sequenceClock(103, 104),
          runIteration: async () => observation
        })
      )

      // Then: returned and persisted decisions agree with generic parser authority.
      expect(result.iterations[0]).toMatchObject({
        observation: null,
        breakageCategory: RampBreakageCategory.InvalidObservation
      })
      expect(result.iterations[0]).not.toMatchObject({
        breakageCategory: RampBreakageCategory.Workload
      })
      const iteration = result.iterations[0]
      if (iteration?.kind !== "breakage")
        throw new Error("invalid observation result must be breakage")
      expect(readLifecycleManifest(fixture.lifecycle.runDirectory)).toMatchObject({
        lifecycle: RunEvidenceLifecycle.Failed,
        preserveCluster: true
      })
      expect(readLifecycleTerminal(fixture.lifecycle.runDirectory)).toMatchObject({
        breakageCategory: iteration.breakageCategory,
        breakageReason: iteration.breakageReason
      })
      expect(verifyRunEvidence(fixture.lifecycle.runDirectory)).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.NonSuccess
      })
    } finally {
      fixture.cleanup()
    }
  })
})

function workloadObservation(
  saturatedEndpoints: readonly RunEvidenceEndpoint[]
): SwapStressIterationObservation {
  return {
    kind: "breakage",
    saturatedEndpoints,
    observedNonRequiredEndpoints: [],
    breakageCategory: RampBreakageCategory.Workload,
    breakageReason: WorkloadReason,
    evidence: { phaseResults: [], telemetryDegradation: null }
  }
}

async function runningFixture() {
  const workspace = createLifecycleWorkspace(),
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
      {
        persistence: lifecycleAllocationDependencies(),
        clock: sequenceClock(101, 102)
      }
    )
  const setup = await lifecycle.setup(async () => {
    createClusterConfig(workspace)
    return { context: { clusterPath: workspace.clusterPath } }
  })
  if (setup.kind !== "succeeded") throw new Error("fixture setup must succeed")
  return { lifecycle, cleanup: workspace.cleanup }
}

function sequenceClock(...values: readonly number[]): () => number {
  const clock = jest.fn<number, []>()
  values.forEach(value => clock.mockReturnValueOnce(value))
  return clock
}
