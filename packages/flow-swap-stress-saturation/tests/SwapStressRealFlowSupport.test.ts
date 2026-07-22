import {
  RampBreakageCategory,
  RunEvidenceEndpoint
} from "@wireio/test-opp-stress"

import {
  cleanupRealStressFlow,
  formatRealBaselineOutcome
} from "./swapStressRealFlowSupport.js"
import { strictSnapshotMetrics } from "./phaseRunnerMetricFixtures.js"
import { registerRealFlowRampLifecycleBranches } from "./realFlowRampLifecycleBranches.js"
import { registerRealFlowSetupLifecycleBranches } from "./realFlowSetupLifecycleBranches.js"
import { registerRealFlowExitLifecycleBranches } from "./realFlowExitLifecycleBranches.js"
import { registerRealFlowConfigFaultBranches } from "./realFlowConfigFaultBranches.js"
import { registerRealFlowTerminalAuthorityBranches } from "./realFlowTerminalAuthorityBranches.js"
import { registerRealFlowSetupPublicationFaultBranches } from "./realFlowSetupPublicationFaultBranches.js"
import { registerRealFlowPersistentPublicationFaultBranches } from "./realFlowPersistentPublicationFaultBranches.js"
import { registerRealFlowFinalizationCauseBranches } from "./realFlowFinalizationCauseBranches.js"
import type { SwapStressIterationObservation } from "@wireio/test-flow-swap-stress-saturation"

registerRealFlowSetupLifecycleBranches()
registerRealFlowRampLifecycleBranches()
registerRealFlowExitLifecycleBranches()
registerRealFlowConfigFaultBranches()
registerRealFlowTerminalAuthorityBranches()
registerRealFlowSetupPublicationFaultBranches()
registerRealFlowPersistentPublicationFaultBranches()
registerRealFlowFinalizationCauseBranches()

describe("real swap stress cleanup", () => {
  it("kills child processes when setup failed before a flow was assigned", async () => {
    // Given: createRealStressFlow started child processes, then threw before returning a flow.
    const calls: string[] = []

    // When: afterAll cleanup runs with no flow but with setupFailed recorded.
    await cleanupRealStressFlow({
      flow: null,
      result: { preserveCluster: true },
      cleanup: {
        killAll: async () => {
          calls.push("killAll")
        },
        warn: message => calls.push(`warn:${message}`),
        removeCluster: async clusterPath => {
          calls.push(`remove:${clusterPath}`)
        }
      }
    })

    // Then: cluster data is preserved while orphaned child processes are killed.
    expect(calls).toEqual(["killAll"])
  })

  it("preserves cluster files while closing runtime resources", async () => {
    // Given: the real flow completed with preserveCluster still enabled.
    const calls: string[] = [],
      flow = {
        context: {
          clusterPath: "/tmp/swap-stress-preserved",
          teardown: async () => {
            calls.push("teardown")
          }
        }
      }

    // When: afterAll cleanup runs for a successful preserved flow.
    await cleanupRealStressFlow({
      flow,
      result: { preserveCluster: true },
      cleanup: {
        killAll: async () => {
          calls.push("killAll")
        },
        warn: message => calls.push(`warn:${message}`),
        removeCluster: async clusterPath => {
          calls.push(`remove:${clusterPath}`)
        }
      }
    })

    // Then: the cluster stays on disk while runtime resources and child processes stop.
    expect(calls).toEqual([
      "warn:[SwapStressSaturation] preserving cluster at /tmp/swap-stress-preserved",
      "teardown",
      "killAll"
    ])
  })

  it("tears down and kills successful clusters when preservation is disabled", async () => {
    // Given: the real flow saturated and allowed normal teardown.
    const calls: string[] = [],
      flow = {
        context: {
          clusterPath: "/tmp/swap-stress-clean",
          teardown: async () => {
            calls.push("teardown")
          }
        }
      }

    // When: afterAll cleanup runs for a successful disposable flow.
    await cleanupRealStressFlow({
      flow,
      result: { preserveCluster: false },
      cleanup: {
        killAll: async () => {
          calls.push("killAll")
        },
        warn: message => calls.push(`warn:${message}`),
        removeCluster: async clusterPath => {
          calls.push(`remove:${clusterPath}`)
        }
      }
    })

    // Then: the existing teardown path still stops both flow resources and child processes.
    expect(calls).toEqual([
      "teardown",
      "killAll",
      "remove:/tmp/swap-stress-clean"
    ])
  })

  it("still kills child processes when flow teardown fails", async () => {
    const calls: string[] = [],
      teardownError = new Error("teardown failed")

    const cleanup = cleanupRealStressFlow({
      flow: {
        context: {
          clusterPath: "/tmp/swap-stress-failed-cleanup",
          teardown: async () => {
            calls.push("teardown")
            throw teardownError
          }
        }
      },
      result: { preserveCluster: true },
      cleanup: {
        killAll: async () => {
          calls.push("killAll")
        },
        warn: message => calls.push(`warn:${message}`),
        removeCluster: async clusterPath => {
          calls.push(`remove:${clusterPath}`)
        }
      }
    })

    await expect(cleanup).rejects.toBe(teardownError)
    expect(calls).toEqual([
      "warn:[SwapStressSaturation] preserving cluster at /tmp/swap-stress-failed-cleanup",
      "teardown",
      "killAll"
    ])
  })
})

describe("real swap stress baseline diagnostics", () => {
  it("formats breakage outcomes with BigInt payout fields", () => {
    // Given: a direct real-baseline outcome that contains BigInt payout metadata.
    const outcome: SwapStressIterationObservation = {
      kind: "breakage",
      saturatedEndpoints: [],
      observedNonRequiredEndpoints: [],
      breakageCategory: RampBreakageCategory.Workload,
      breakageReason:
        "phase-2 payout observation failed: Timed out waiting for: phase-2 ETH payout observed",
      evidence: {
        telemetryDegradation: null,
        phaseResults: [
          {
            ...strictSnapshotMetrics({
              phase: "phase-2",
              saturated: false,
              envelopeCount: 1,
              envelopeByteSizes: [512],
              endpoint: RunEvidenceEndpoint.DepotOutpostEthereum,
              epochStart: "13",
              epochEnd: "14"
            }),
            txSuccesses: 3,
            txFailures: 0,
            observationStartedAtMs: 1,
            observationEndedAtMs: 2,
            payout: {
              phase: "phase-2",
              expectedCount: 3,
              minimumObservedCount: 1,
              targetAmount: 99_980_002_000_000_000n,
              targets: [
                {
                  index: 0,
                  address: "0x20a6250c2cb9b6828ce0b16e09b950e7d0d0556d"
                }
              ],
              observedCount: 0
            }
          }
        ]
      }
    }

    // When: the outcome is formatted for an assertion failure.
    const formatted = formatRealBaselineOutcome(outcome)

    // Then: diagnostic fields survive JSON formatting without BigInt serialization errors.
    expect(formatted).toContain('"kind": "breakage"')
    expect(formatted).toContain(
      '"breakageReason": "phase-2 payout observation failed: Timed out waiting for: phase-2 ETH payout observed"'
    )
    expect(formatted).toContain('"targetAmount": "99980002000000000"')
  })
})
