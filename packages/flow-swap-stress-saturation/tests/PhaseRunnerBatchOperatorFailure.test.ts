import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { createSwapStressPhaseRunner } from "@wireio/test-flow-swap-stress-saturation"
import type {
  Phase2SwapRequest,
  SwapStressPhaseRunnerDeps,
  SwapStressReservePairSnapshot
} from "@wireio/test-flow-swap-stress-saturation"

import { strictSnapshotMetrics } from "./phaseRunnerMetricFixtures.js"

describe("createSwapStressPhaseRunner batch operator failures", () => {
  it("reports a batch operator failure instead of the phase 1 payout timeout", async () => {
    // Given: the payout observer times out after a batch operator delivery rejection is visible.
    const deps = createDeps()

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: the runner keeps phase 2 evidence but classifies the concrete batchop rejection.
    expect(outcome.kind).toBe("breakage")
    if (outcome.kind !== "breakage") throw new Error("breakage expected")
    expect(outcome.breakageReason).toBe(
      "phase-1 batch operator failure: outpost_opp_job[23373300651341:CHAIN_KIND_EVM:31337]: outbound delivery failed: execution reverted"
    )
    expect(outcome.evidence.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(deps.phase2Requests).toHaveLength(2)
  })

  it("reports a phase 2 batch operator failure instead of saturated completion", async () => {
    // Given: all Ethereum endpoint evidence is saturated, but phase 2 has a concrete batchop rejection.
    const deps = createDeps({
      phase1BatchOperatorFailure: false,
      phase2BatchOperatorFailure: true,
      phase2MetricsSaturated: true
    })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: transaction rejection remains breakage even when all-legs evidence exists.
    expect(outcome.kind).toBe("breakage")
    if (outcome.kind !== "breakage") throw new Error("breakage expected")
    expect(outcome.breakageReason).toBe(
      "phase-2 batch operator failure: outpost_opp_job[23373300651341:CHAIN_KIND_EVM:31337]: outbound delivery failed: execution reverted"
    )
    expect(outcome.saturatedEndpoints).toEqual([
      "OUTPOST_ETHEREUM_DEPOT",
      "DEPOT_OUTPOST_ETHEREUM"
    ])
  })

  it("reports a phase 2 payout timeout instead of saturated completion", async () => {
    // Given: all Ethereum endpoint evidence is saturated, but phase 2 payout observation times out without a concrete batchop rejection.
    const deps = createDeps({
      phase1BatchOperatorFailure: false,
      phase2PayoutFailure: true,
      phase2MetricsSaturated: true
    })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: payout timeout remains breakage even when all-legs evidence exists.
    expect(outcome.kind).toBe("breakage")
    if (outcome.kind !== "breakage") throw new Error("breakage expected")
    expect(outcome.breakageReason).toBe(
      "phase-2 payout observation failed: Timed out waiting for: phase-2 payout observed"
    )
    expect(outcome.saturatedEndpoints).toEqual([
      "OUTPOST_ETHEREUM_DEPOT",
      "DEPOT_OUTPOST_ETHEREUM"
    ])
  })
})

type TestDeps = SwapStressPhaseRunnerDeps & {
  readonly phase2Requests: Phase2SwapRequest[]
}

type TestDepsOptions = {
  readonly phase1BatchOperatorFailure?: boolean
  readonly phase2BatchOperatorFailure?: boolean
  readonly phase2PayoutFailure?: boolean
  readonly phase2MetricsSaturated?: boolean
}

function createDeps(options: TestDepsOptions = {}): TestDeps {
  const phase2Requests: Phase2SwapRequest[] = []
  return {
    telemetryKind: "synthetic",
    route: {
      ethereumChainCode: 1n,
      ethereumTokenCode: 2n,
      solanaChainCode: 3n,
      solanaTokenCode: 4n,
      wireChainCode: 5n,
      wireTokenCode: 6n,
      wireSentinelReserveCode: 7n,
      privateReserveCode: 8n
    },
    readReservePairSnapshot: async () => defaultReserveSnapshot(),
    getEthereumFirstNonce: async () => 9,
    ethereumReserveManager: {
      requestSwap: async (
        _sourceToken,
        _sourceReserve,
        _targetChain,
        _targetToken,
        _targetReserve,
        _recipient,
        _targetAmount,
        _tolerance,
        overrides
      ) => ({
        wait: async () => ({
          status: 1,
          hash: `0x${overrides.nonce}`,
          blockNumber: overrides.nonce,
          gasUsed: BigInt(overrides.nonce)
        })
      })
    },
    submitPhase2Swap: async request => {
      phase2Requests.push(request.request)
      return `sig-${request.index}`
    },
    recipientPayoutObserver: payoutObserver({
      failingPhase:
        options.phase1BatchOperatorFailure === false ? null : "phase-1"
    }),
    returnPayoutObserver: payoutObserver({
      failingPhase:
        options.phase2BatchOperatorFailure === true ||
        options.phase2PayoutFailure === true
          ? "phase-2"
          : null
    }),
    batchOperatorFailureProbe: async request =>
      request.phase === "phase-1" ||
      (request.phase === "phase-2" &&
        options.phase2BatchOperatorFailure === true)
        ? "outpost_opp_job[23373300651341:CHAIN_KIND_EVM:31337]: outbound delivery failed: execution reverted"
        : null,
    collectEnvelopeMetrics: async request =>
      strictSnapshotMetrics({
        phase: request.phase,
        saturated:
          request.phase === "phase-1" ||
          options.phase2MetricsSaturated === true,
        envelopeCount: 2,
        envelopeByteSizes: [527, 527],
        endpoint: DebugOutpostEndpointsType[request.endpointsType],
        epochStart: "7",
        epochEnd: "8"
      }),
    clock: fixedClock(),
    concurrency: 2,
    phase2Requests
  }
}

function defaultReserveSnapshot(): SwapStressReservePairSnapshot {
  return {
    ethereum: { chain: 1_000_000_000_000n, wire: 1_000_000_000_000n },
    solana: { chain: 1_000_000_000n, wire: 1_000_000_000_000n }
  }
}

function payoutObserver(options: {
  readonly failingPhase: "phase-1" | "phase-2" | null
}): SwapStressPhaseRunnerDeps["recipientPayoutObserver"] {
  return {
    waitForPayouts: async request => {
      if (request.phase === options.failingPhase)
        throw new Error(
          `Timed out waiting for: ${request.phase} payout observed`
        )
      return {
        phase: request.phase,
        observedCount: request.minimumObservedCount,
        expectedCount: request.expectedCount,
        minimumObservedCount: request.minimumObservedCount,
        targetAmount: request.targetAmount,
        targets: request.targets
      }
    }
  }
}

function fixedClock(): () => number {
  const times = [1_000, 1_010, 1_020, 1_030, 1_040]
  return () => times.shift() ?? 1_050
}
