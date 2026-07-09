import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { createSwapStressPhaseRunner } from "@wireio/test-flow-swap-stress-saturation"
import type {
  Phase2SwapRequest,
  SwapStressPhaseRunnerDeps,
  SwapStressReservePairSnapshot
} from "@wireio/test-flow-swap-stress-saturation"

describe("createSwapStressPhaseRunner phase metrics", () => {
  it("measures phase 2 return evidence with the depot to Ethereum endpoint", async () => {
    // Given: both Ethereum directions produce rollover evidence during a clean iteration.
    const deps = createDeps()

    // When: one bidirectional iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: phase 2 contributes the Ethereum return endpoint required by all-legs evidence.
    expect(outcome.kind).toBe("saturated")
    expect(outcome.phaseResults[1]?.endpoint).toBe("DEPOT_OUTPOST_ETHEREUM")
    expect(outcome.saturatedEndpoints).toEqual([
      "OUTPOST_ETHEREUM_DEPOT",
      "DEPOT_OUTPOST_ETHEREUM"
    ])
    expect(outcome.missingEndpoints).toEqual([])
  })

  it("collects phase 2 return metrics after waiting for return payouts", async () => {
    // Given: the return envelope is only visible after the phase 2 payout wait.
    const events: string[] = [],
      deps = createDeps({ events })

    // When: one bidirectional iteration runs.
    await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: the metrics window includes post-payout OPP envelopes.
    expect(events.indexOf("payout:phase-2")).toBeGreaterThan(-1)
    expect(
      events.indexOf("metrics:phase-2:DEPOT_OUTPOST_ETHEREUM:after-payout")
    ).toBeGreaterThan(events.indexOf("payout:phase-2"))
  })

  it("rechecks phase 1 Ethereum source evidence after payout timeout before Solana diagnostics", async () => {
    // Given: phase 1 source evidence becomes saturated only after the payout wait times out.
    const events: string[] = [],
      deps = createDeps({
        events,
        phase1PayoutFailureReason:
          "Timed out waiting for: phase-1 WIRE payout observed",
        phase1SourceSaturatedAfterPayoutFailure: true,
        phase1DiagnosticSaturated: true
      })

    // When: the iteration continues to phase 2 to gather evidence despite phase 1 payout breakage.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: the preserved phase 1 result uses the required Ethereum source endpoint.
    expect(outcome.kind).toBe("breakage")
    expect(outcome.phaseResults[0]?.endpoint).toBe("OUTPOST_ETHEREUM_DEPOT")
    expect(outcome.saturatedEndpoints).toContain("OUTPOST_ETHEREUM_DEPOT")
    expect(events).toEqual(
      expect.arrayContaining([
        "metrics:phase-1:OUTPOST_ETHEREUM_DEPOT:before-payout",
        "payout:phase-1",
        "metrics:phase-1:OUTPOST_ETHEREUM_DEPOT:after-payout",
        "metrics:phase-2:DEPOT_OUTPOST_ETHEREUM:after-payout"
      ])
    )
    expect(events).not.toContain(
      "metrics:phase-1:DEPOT_OUTPOST_SOLANA:after-payout"
    )
  })
})

type TestDeps = SwapStressPhaseRunnerDeps & {
  readonly phase2Requests: Phase2SwapRequest[]
}

type TestDepsOptions = {
  readonly events?: string[]
  readonly phase1PayoutFailureReason?: string
  readonly phase1SourceSaturatedAfterPayoutFailure?: boolean
  readonly phase1DiagnosticSaturated?: boolean
}

function createDeps(options: TestDepsOptions = {}): TestDeps {
  const phase2Requests: Phase2SwapRequest[] = []
  return {
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
    recipientPayoutObserver: payoutObserver(options),
    returnPayoutObserver: payoutObserver(options),
    collectEnvelopeMetrics: async request => {
      const timing = options.events?.includes(`payout:${request.phase}`)
        ? "after-payout"
        : "before-payout"
      options.events?.push(
        `metrics:${request.phase}:${DebugOutpostEndpointsType[request.endpointsType]}:${timing}`
      )
      const saturated =
        request.phase === "phase-1"
          ? phase1Saturated(request, options, timing)
          : request.endpointsType ===
            DebugOutpostEndpointsType.DEPOT_OUTPOST_ETHEREUM
      return {
        phase: request.phase,
        saturated,
        envelopeCount: 2,
        envelopeByteSizes: [527, 527],
        endpoint: DebugOutpostEndpointsType[request.endpointsType],
        epochStart: 7,
        epochEnd: 8
      }
    },
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

function payoutObserver(
  options: TestDepsOptions
): SwapStressPhaseRunnerDeps["recipientPayoutObserver"] {
  return {
    waitForPayouts: async request => {
      options.events?.push(`payout:${request.phase}`)
      if (
        request.phase === "phase-1" &&
        options.phase1PayoutFailureReason !== undefined
      ) {
        throw new Error(options.phase1PayoutFailureReason)
      }
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

function phase1Saturated(
  request: Parameters<
    Exclude<SwapStressPhaseRunnerDeps["collectEnvelopeMetrics"], undefined>
  >[0],
  options: TestDepsOptions,
  timing: string
): boolean {
  if (
    request.endpointsType === DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
  ) {
    return options.phase1DiagnosticSaturated ?? false
  }
  return timing === "after-payout"
    ? (options.phase1SourceSaturatedAfterPayoutFailure ?? true)
    : options.phase1PayoutFailureReason === undefined
}

function fixedClock(): () => number {
  const times = [1_000, 1_010, 1_020, 1_030]
  return () => times.shift() ?? 1_040
}
