import * as Fs from "node:fs"
import * as OS from "node:os"
import * as Path from "node:path"

import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import {
  cleanupRealStressFlow,
  formatRealBaselineOutcome,
  writeSetupFailureEvidence
} from "./swapStressRealFlowSupport.js"
import type { SwapStressIterationOutcome } from "@wireio/test-flow-swap-stress-saturation"

describe("real swap stress cleanup", () => {
  it("kills child processes when setup failed before a flow was assigned", async () => {
    // Given: createRealStressFlow started child processes, then threw before returning a flow.
    const calls: string[] = []

    // When: afterAll cleanup runs with no flow but with setupFailed recorded.
    await cleanupRealStressFlow({
      flow: null,
      preserveCluster: true,
      setupFailed: true,
      cleanup: {
        killAll: async () => {
          calls.push("killAll")
        },
        warn: message => calls.push(`warn:${message}`)
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
      preserveCluster: true,
      setupFailed: false,
      cleanup: {
        killAll: async () => {
          calls.push("killAll")
        },
        warn: message => calls.push(`warn:${message}`)
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
      preserveCluster: false,
      setupFailed: false,
      cleanup: {
        killAll: async () => {
          calls.push("killAll")
        },
        warn: message => calls.push(`warn:${message}`)
      }
    })

    // Then: the existing teardown path still stops both flow resources and child processes.
    expect(calls).toEqual(["teardown", "killAll"])
  })
})

describe("real swap stress setup failure evidence", () => {
  it("writes failed_before_saturation evidence under the cluster data directory", async () => {
    // Given: real flow setup fails before runSaturationRamp can create evidence.
    const clusterPath = Fs.mkdtempSync(
        Path.join(OS.tmpdir(), "swap-stress-real-setup-failure-")
      ),
      setupError = new Error(
        "setup reverted while creating Ethereum private reserve"
      )

    // When: the setup-failure evidence writer records the failed bootstrap.
    await writeSetupFailureEvidence(clusterPath, setupError)

    // Then: iteration-0 evidence classifies the run as setup-time failure, not success.
    const evidence = readEvidence(clusterPath)
    expect(evidence.status).toBe("failed_before_saturation")
    expect(evidence.kind).toBe("failed_before_saturation")
    expect(evidence.preserveCluster).toBe(true)
    expect(evidence.breakageReason).toContain(setupError.message)
    expect(evidence.missingEndpoints).toEqual([
      DebugOutpostEndpointsType[
        DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
      ],
      DebugOutpostEndpointsType[
        DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
      ]
    ])
    expect(evidence.saturatedEndpoints).toEqual([])
    expect(evidence.status).not.toBe("saturated")
  })
})

describe("real swap stress baseline diagnostics", () => {
  it("formats breakage outcomes with BigInt payout fields", () => {
    // Given: a direct real-baseline outcome that contains BigInt payout metadata.
    const outcome: SwapStressIterationOutcome = {
      kind: "breakage",
      iterationIndex: 0,
      accountCount: 3,
      phase: "phase-2",
      startedAtMs: 1,
      endedAtMs: 2,
      txSuccesses: 6,
      txFailures: 0,
      envelopeCount: 1,
      envelopeByteSizes: [512],
      endpoint:
        DebugOutpostEndpointsType[
          DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
        ],
      epochStart: 13,
      epochEnd: 14,
      saturatedEndpoints: [],
      missingEndpoints: [],
      observedNonRequiredEndpoints: [],
      breakageReason:
        "phase-2 payout observation failed: Timed out waiting for: phase-2 ETH payout observed",
      phaseResults: [
        {
          phase: "phase-2",
          saturated: false,
          envelopeCount: 1,
          envelopeByteSizes: [512],
          endpoint:
            DebugOutpostEndpointsType[
              DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
            ],
          epochStart: 13,
          epochEnd: 14,
          txSuccesses: 3,
          txFailures: 0,
          startedAtMs: 1,
          endedAtMs: 2,
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

function readEvidence(clusterPath: string): Record<string, unknown> {
  const evidencePath = Path.join(
      clusterPath,
      "data",
      "swap-stress-saturation",
      "iteration-0.json"
    ),
    parsed: unknown = JSON.parse(Fs.readFileSync(evidencePath, "utf-8"))
  if (!isRecord(parsed)) throw new Error("setup evidence was not a JSON object")
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
