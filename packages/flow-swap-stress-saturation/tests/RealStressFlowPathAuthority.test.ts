import Fs from "node:fs"
import Path from "node:path"

import {
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidenceVerificationVerdict,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { createRealStressFlow } from "./real/realFlowSetup.js"
import { RealStressFlowLifecycle } from "./real/realFlowLifecycle.js"
import {
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

describe("real stress canonical source path", () => {
  it("resolves a relative cluster path once before allocation and setup", async () => {
    // Given: WIRE_CLUSTER_PATH semantics provide a relative fresh-cluster path.
    const workspace = createLifecycleWorkspace(),
      relativePath = Path.relative(process.cwd(), workspace.clusterPath),
      expectedPath = Path.resolve(relativePath),
      lifecycle = await RealStressFlowLifecycle.allocate(
        allocationOptions(relativePath),
        {
          persistence: lifecycleAllocationDependencies(),
          clock: sequenceClock(101, 102)
        }
      )
    try {
      // When: setup creates the cluster at the lifecycle-owned path.
      const outcome = await lifecycle.setup(async clusterPath => {
        expect(clusterPath).toBe(expectedPath)
        Fs.mkdirSync(clusterPath, { recursive: true })
        Fs.writeFileSync(
          Path.join(clusterPath, "cluster-config.json"),
          "{\"cluster\":\"test\"}\n"
        )
        return { context: { clusterPath } }
      })

      // Then: source identity, flow context, and manifest use the same absolute root.
      expect(outcome.kind).toBe("succeeded")
      expect(lifecycle.clusterPath).toBe(expectedPath)
      expect(readLifecycleManifest(lifecycle.runDirectory).clusterPath).toBe(
        expectedPath
      )
    } finally {
      workspace.cleanup()
    }
  })

  it("terminalizes a created flow whose context reports another source root", async () => {
    // Given: allocation owns one root but flow creation returns another.
    const workspace = createLifecycleWorkspace(),
      lifecycle = await RealStressFlowLifecycle.allocate(
        allocationOptions(workspace.clusterPath),
        {
          persistence: lifecycleAllocationDependencies(),
          clock: sequenceClock(101, 102)
        }
      )
    try {
      // When: post-creation source identity validation observes the mismatch.
      const outcome = await lifecycle.setup(async () => ({
        context: { clusterPath: Path.join(workspace.root, "attached-cluster") }
      }))

      // Then: setup fails canonically, preserves the cluster, and never enters running.
      expect(outcome).toMatchObject({
        kind: "failed",
        result: {
          lifecycle: RunEvidenceLifecycle.SetupFailed,
          preserveCluster: true
        }
      })
      if (outcome.kind !== "failed") throw new Error("path mismatch must fail")
      expect(outcome.cause).toMatchObject({
        name: "RealStressClusterPathMismatchError"
      })
      expect(verifyRunEvidence(lifecycle.runDirectory)).toMatchObject({
        valid: true,
        verdict: RunEvidenceVerificationVerdict.NonSuccess,
        lifecycle: RunEvidenceLifecycle.SetupFailed
      })
    } finally {
      workspace.cleanup()
    }
  })

  it("rejects inherited attach mode before FlowTestContext setup", async () => {
    // Given: a parent shell supplies an attach-mode cluster config.
    const workspace = createLifecycleWorkspace(),
      previous = process.env.WIRE_CLUSTER_CONFIG
    Fs.mkdirSync(workspace.clusterPath, { recursive: true })
    Fs.writeFileSync(workspace.configPath, "{}\n")
    process.env.WIRE_CLUSTER_CONFIG = workspace.configPath
    try {
      // When/Then: the stress flow refuses attach mode before reading that config.
      await expect(createRealStressFlow(workspace.clusterPath)).rejects.toMatchObject({
        name: "RealStressAttachModeError"
      })
    } finally {
      if (previous === undefined) delete process.env.WIRE_CLUSTER_CONFIG
      else process.env.WIRE_CLUSTER_CONFIG = previous
      workspace.cleanup()
    }
  })
})

function allocationOptions(clusterPath: string) {
  return {
    clusterPath,
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
  } as const
}

function sequenceClock(...values: readonly number[]): () => number {
  const clock = jest.fn<number, []>()
  values.forEach(value => clock.mockReturnValueOnce(value))
  return clock
}
