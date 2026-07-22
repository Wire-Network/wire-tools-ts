import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  RunEvidenceClusterConfigState,
  RunEvidenceLifecycle,
  RunEvidenceEndpoint,
  RunEvidencePath,
  RunEvidenceSetupStatus,
  RunEvidenceVerificationVerdict,
  verifyRunEvidence
} from "@wireio/test-opp-stress"

import { RealStressFlowLifecycle } from "./real/realFlowLifecycle.js"
import {
  createClusterConfig,
  createLifecycleWorkspace,
  lifecycleAllocationDependencies,
  readLifecycleManifest
} from "./realFlowLifecycleTestSupport.js"

/** Register deterministic setup and interruption lifecycle acceptance tests. */
export function registerRealFlowSetupLifecycleBranches(): void {
  describe("real swap stress canonical setup lifecycle", () => {
    it("allocates external initializing evidence before setup begins", async () => {
      const workspace = createLifecycleWorkspace(),
        events: string[] = []
      try {
        const lifecycle = await RealStressFlowLifecycle.allocate(
          allocationOptions(workspace.clusterPath),
          {
            persistence: lifecycleAllocationDependencies(),
            clock: sequenceClock(101, 102)
          }
        )
        events.push("allocated")

        const report = verifyRunEvidence(lifecycle.runDirectory)
        expect(events).toEqual(["allocated"])
        expect(lifecycle.runDirectory).toBe(
          Path.join(
            `${workspace.clusterPath}-swap-stress-evidence`,
            "runs",
            lifecycle.runId
          )
        )
        expect(lifecycle.runDirectory.startsWith(`${workspace.clusterPath}/`)).toBe(false)
        expect(report).toMatchObject({
          valid: true,
          verdict: RunEvidenceVerificationVerdict.InProgress,
          lifecycle: RunEvidenceLifecycle.Initializing
        })
        expect(readLifecycleManifest(lifecycle.runDirectory)).toMatchObject({
          clusterConfigSnapshot: { kind: RunEvidenceClusterConfigState.Pending },
          records: { setup: { kind: "pending" }, terminal: null }
        })
      } finally {
        workspace.cleanup()
      }
    })

    it.each([false, true])(
      "terminalizes setup failure when config-created is %s",
      async configCreated => {
        const workspace = createLifecycleWorkspace(),
          setupError = new Error("setup failed")
        try {
          const lifecycle = await RealStressFlowLifecycle.allocate(
            allocationOptions(workspace.clusterPath),
            {
              persistence: lifecycleAllocationDependencies(),
              clock: sequenceClock(101, 102)
            }
          )
          const outcome = await lifecycle.setup(async clusterPath => {
            expect(clusterPath).toBe(workspace.clusterPath)
            if (configCreated) createClusterConfig(workspace)
            throw setupError
          })

          expect(outcome).toMatchObject({
            kind: "failed",
            cause: setupError,
            result: { preserveCluster: true }
          })
          const manifest = readLifecycleManifest(lifecycle.runDirectory),
            report = verifyRunEvidence(lifecycle.runDirectory)
          expect(manifest).toMatchObject({
            lifecycle: RunEvidenceLifecycle.SetupFailed,
            clusterConfigSnapshot: configCreated
              ? { kind: RunEvidenceClusterConfigState.Captured }
              : {
                  kind: RunEvidenceClusterConfigState.Unavailable,
                  reason: "cluster_config_not_created"
                }
          })
          expect(report).toMatchObject({
            valid: true,
            verdict: RunEvidenceVerificationVerdict.NonSuccess
          })
          expect(
            Fs.existsSync(Path.join(lifecycle.runDirectory, "iteration-0.json"))
          ).toBe(false)
        } finally {
          workspace.cleanup()
        }
      }
    )

    it("captures config and enters running after successful setup", async () => {
      const workspace = createLifecycleWorkspace()
      try {
        const lifecycle = await RealStressFlowLifecycle.allocate(
            allocationOptions(workspace.clusterPath),
            {
              persistence: lifecycleAllocationDependencies(),
              clock: sequenceClock(101, 102)
            }
          ),
          flow = { context: { clusterPath: workspace.clusterPath } }
        const outcome = await lifecycle.setup(async () => {
          createClusterConfig(workspace)
          return flow
        })

        expect(outcome).toEqual({ kind: "succeeded", flow })
        expect(readLifecycleManifest(lifecycle.runDirectory)).toMatchObject({
          lifecycle: RunEvidenceLifecycle.Running,
          clusterConfigSnapshot: {
            kind: RunEvidenceClusterConfigState.Captured,
            path: RunEvidencePath.ClusterConfigSnapshot
          }
        })
        const setup = JSON.parse(
          Fs.readFileSync(
            Path.join(lifecycle.runDirectory, RunEvidencePath.Setup),
            "utf8"
          )
        )
        expect(setup).toMatchObject({
          status: RunEvidenceSetupStatus.Succeeded,
          clusterConfigCreated: true
        })
      } finally {
        workspace.cleanup()
      }
    })

  })
}

function allocationOptions(clusterPath: string) {
  return {
    clusterPath,
    rampConfig: {
      initialCount: 1,
      multiplier: 2,
      maxCount: 1,
      phaseTimeoutMs: 30_000
    },
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
