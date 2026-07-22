import { AtomicFile } from "@wireio/debugging-shared"
import {
  RunEvidenceEndpoint,
  type RunEvidencePersistence
} from "@wireio/test-opp-stress"

import { RealStressFlowLifecycle } from "./real/realFlowLifecycle.js"
import {
  createClusterConfig,
  createLifecycleWorkspace,
  lifecycleAllocationDependencies,
  type LifecycleWorkspace
} from "./realFlowLifecycleTestSupport.js"

const Config = {
  initialCount: 1,
  multiplier: 2,
  maxCount: 1,
  phaseTimeoutMs: 30_000
} as const

/** Inputs for one flow lifecycle backed by real AtomicFile fault collaborators. */
export type AtomicFaultLifecycleInput = {
  readonly workspace: LifecycleWorkspace
  readonly fileSystem: NonNullable<AtomicFile.Dependencies["fileSystem"]>
  readonly clockValues?: readonly number[]
}

/** Allocate one lifecycle whose publications use the supplied filesystem faults. */
export async function allocateAtomicFaultLifecycle(
  input: AtomicFaultLifecycleInput
): Promise<RealStressFlowLifecycle> {
  const persistence: RunEvidencePersistence.Dependencies = {
    ...lifecycleAllocationDependencies(),
    atomicFileDependencies: {
      fileSystem: input.fileSystem,
      tempToken: () => "flow-fault"
    }
  }
  return RealStressFlowLifecycle.allocate(
    {
      clusterPath: input.workspace.clusterPath,
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
      persistence,
      clock: sequenceClock(...(input.clockValues ?? [101, 102, 105, 106]))
    }
  )
}

/** Allocate, capture config, and enter running state with later faults still active. */
export async function runningAtomicFaultFixture(
  fileSystem: NonNullable<AtomicFile.Dependencies["fileSystem"]>
): Promise<{
  readonly lifecycle: RealStressFlowLifecycle
  readonly workspace: LifecycleWorkspace
  readonly cleanup: () => void
}> {
  const workspace = createLifecycleWorkspace(),
    lifecycle = await allocateAtomicFaultLifecycle({ workspace, fileSystem })
  const setup = await lifecycle.setup(async clusterPath => {
    createClusterConfig(workspace)
    return { context: { clusterPath } }
  })
  if (setup.kind !== "succeeded") throw new Error("fixture setup must succeed")
  return { lifecycle, workspace, cleanup: workspace.cleanup }
}

function sequenceClock(...values: readonly number[]): () => number {
  const clock = jest.fn<number, []>()
  values.forEach(value => clock.mockReturnValueOnce(value))
  return clock
}
