import * as Fs from "node:fs"
import * as Path from "node:path"

import {
  OppEnvelopeTelemetryHealthKind,
  OppEnvelopeTelemetryIssueCode,
  OppStressRampTelemetryIntegrityError,
  RampBreakageCategory,
  RunEvidenceEndpoint,
  RunEvidenceLifecycle,
  RunEvidencePath,
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
  readLifecycleTerminal,
  saturatedObservation
} from "./realFlowLifecycleTestSupport.js"
import { orderedBaselineCaptureIssues } from "./phaseRunnerTelemetryTestSupport.js"

/** Register persisted ramp success, failure, and cleanup-authority tests. */
export function registerRealFlowRampLifecycleBranches(): void {
  describe("real swap stress canonical ramp lifecycle", () => {
    it("publishes verifier-valid saturation and canonical cleanup false", async () => {
      const fixture = await runningFixture()
      try {
        const observation = await saturatedObservation(
            fixture.workspace,
            fixture.lifecycle.persistence
          ),
          result = await fixture.lifecycle.ramp(() =>
            runSaturationRamp({
              persistence: fixture.lifecycle.persistence,
              config: fixture.config,
              clock: sequenceClock(103, 104),
              runIteration: async () => observation
            })
          )

        expect(result).toMatchObject({ status: "saturated", preserveCluster: false })
        expect(readLifecycleTerminal(fixture.lifecycle.runDirectory)).toMatchObject({
          lifecycle: RunEvidenceLifecycle.Saturated,
          preserveCluster: result.preserveCluster
        })
        expect(fixture.lifecycle.canonicalResult).toEqual(result)
        expect(verifyRunEvidence(fixture.lifecycle.runDirectory)).toMatchObject({
          valid: true,
          verdict: RunEvidenceVerificationVerdict.Saturated,
          lifecycle: RunEvidenceLifecycle.Saturated
        })
        expect(canonicalEntries(fixture.lifecycle.runDirectory)).toEqual([
          Path.dirname(RunEvidencePath.Artifacts),
          RunEvidencePath.ClusterConfigSnapshot,
          RunEvidencePath.Iterations,
          RunEvidencePath.Manifest,
          RunEvidencePath.Setup,
          RunEvidencePath.Terminal
        ])
      } finally {
        fixture.workspace.cleanup()
      }
    })

    it("persists a typed telemetry observation with its exact cause", async () => {
      const fixture = await runningFixture(),
        issues = orderedBaselineCaptureIssues(),
        observation = {
          kind: "breakage",
          saturatedEndpoints: [],
          observedNonRequiredEndpoints: [],
          breakageCategory: RampBreakageCategory.TelemetryIntegrity,
          breakageReason: "phase-1 OPP telemetry degraded",
          evidence: {
            phaseResults: [],
            telemetryDegradation: {
              kind: "baseline_capture_failed",
              issues
            }
          }
        } as const
      try {
        const result = await fixture.lifecycle.ramp(() =>
          runSaturationRamp({
            persistence: fixture.lifecycle.persistence,
            config: fixture.config,
            clock: sequenceClock(103, 104),
            runIteration: async () => observation
          })
        )

        expect(result.iterations[0]).toMatchObject({
          observation,
          breakageCategory: RampBreakageCategory.TelemetryIntegrity,
          breakageReason: observation.breakageReason
        })
        expect(readLifecycleManifest(fixture.lifecycle.runDirectory).telemetry).toMatchObject({
          issueCount: issues.length,
          issues: issues.map(issue => expect.objectContaining({ code: issue.code }))
        })
        const iteration = result.iterations[0]
        if (iteration?.kind !== "breakage")
          throw new Error("telemetry observation must be breakage")
        expect(readLifecycleTerminal(fixture.lifecycle.runDirectory)).toMatchObject({
          breakageCategory: iteration.breakageCategory,
          breakageReason: iteration.breakageReason
        })
        expect(verifyRunEvidence(fixture.lifecycle.runDirectory)).toMatchObject({
          valid: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess,
          lifecycle: RunEvidenceLifecycle.Failed
        })
      } finally {
        fixture.workspace.cleanup()
      }
    })

    it.each([
      [
        "typed telemetry",
        new OppStressRampTelemetryIntegrityError("telemetry failed", {
          kind: OppEnvelopeTelemetryHealthKind.Degraded,
          retryable: false,
          candidateCount: 0,
          validCount: 0,
          filteredCount: 0,
          issueCount: 1,
          issues: [
            {
              code: OppEnvelopeTelemetryIssueCode.StorageRootReadFailed,
              baseKey: "$storage",
              context: {
                path: "/cluster/data/opp-debugging",
                error: {
                  name: "Error",
                  code: "EIO",
                  message: "read failed",
                  operation: "root_open"
                }
              }
            }
          ]
        })
      ],
      ["unexpected callback", new Error("unexpected ramp failure")]
    ] as const)("publishes verifier-valid %s failure", async (_label, cause) => {
      const fixture = await runningFixture()
      try {
        const result = await fixture.lifecycle.ramp(() =>
          runSaturationRamp({
            persistence: fixture.lifecycle.persistence,
            config: fixture.config,
            clock: sequenceClock(103, 104),
            runIteration: () => Promise.reject(cause)
          })
        )

        expect(result.preserveCluster).toBe(true)
        expect(result.iterations[0]).toMatchObject({ observation: null, cause })
        const iteration = result.iterations[0]
        if (iteration?.kind !== "breakage")
          throw new Error("callback rejection must be breakage")
        expect(verifyRunEvidence(fixture.lifecycle.runDirectory)).toMatchObject({
          valid: true,
          verdict: RunEvidenceVerificationVerdict.NonSuccess,
          lifecycle: RunEvidenceLifecycle.Failed
        })
        expect(readLifecycleManifest(fixture.lifecycle.runDirectory)).toMatchObject({
          lifecycle: RunEvidenceLifecycle.Failed,
          preserveCluster: true
        })
        expect(readLifecycleTerminal(fixture.lifecycle.runDirectory)).toMatchObject({
          breakageCategory: iteration.breakageCategory,
          breakageReason: iteration.breakageReason
        })
      } finally {
        fixture.workspace.cleanup()
      }
    })

  })
}

async function runningFixture() {
  const workspace = createLifecycleWorkspace(),
    config = {
      initialCount: 1,
      multiplier: 2,
      maxCount: 1,
      phaseTimeoutMs: 30_000
    } as const,
    lifecycle = await RealStressFlowLifecycle.allocate(
      {
        clusterPath: workspace.clusterPath,
        rampConfig: config,
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
  return { workspace, config, lifecycle }
}

function canonicalEntries(runDirectory: string): readonly string[] {
  return Fs.readdirSync(runDirectory).sort()
}

function sequenceClock(...values: readonly number[]): () => number {
  const clock = jest.fn<number, []>()
  values.forEach(value => clock.mockReturnValueOnce(value))
  return clock
}
