import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import {
  createSwapStressPhaseRunner,
  SolanaRawTransactionBytesMax
} from "@wireio/test-flow-swap-stress-saturation"
import type {
  Phase2SwapRequest,
  SwapStressPhaseRunnerDeps,
  SwapStressReservePairSnapshot
} from "@wireio/test-flow-swap-stress-saturation"

describe("createSwapStressPhaseRunner", () => {
  it("completes both phases for count 2 after recipient and return payouts", async () => {
    // Given: live reserve rows produce positive two-hop quotes for both directions.
    const deps = createDeps()

    // When: one iteration runs with two generated recipient pairs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: both bounded bursts ran and both payout surfaces observed delivery.
    expect(outcome.kind).toBe("not_saturated")
    expect(outcome.txSuccesses).toBe(4)
    expect(outcome.txFailures).toBe(0)
    expect(outcome.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(deps.payoutObservers.recipient.preparedRequests).toEqual([
      {
        phase: "phase-1",
        expectedCount: 2,
        minimumObservedCount: 1,
        targetAmount: 99_970_006n,
        targets: [
          expect.objectContaining({ index: 0 }),
          expect.objectContaining({ index: 1 })
        ]
      }
    ])
    expect(deps.payoutObservers.recipient.observedRequests).toEqual([
      {
        phase: "phase-1",
        expectedCount: 2,
        minimumObservedCount: 1,
        targetAmount: 99_970_006n,
        targets: [
          expect.objectContaining({ index: 0 }),
          expect.objectContaining({ index: 1 })
        ]
      }
    ])
    expect(deps.payoutObservers.return.preparedRequests).toHaveLength(1)
    expect(deps.payoutObservers.return.observedRequests).toEqual([
      {
        phase: "phase-2",
        expectedCount: 2,
        minimumObservedCount: 1,
        targetAmount: 99_970_006_000_000_000n,
        targets: [
          expect.objectContaining({ index: 0 }),
          expect.objectContaining({ index: 1 })
        ]
      }
    ])
  })

  it("classifies an injected phase 1 burst failure as breakage", async () => {
    // Given: the ETH burst collaborator returns one failed transaction.
    const deps = createDeps({ phase1FailureReason: "injected phase 1 revert" })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: the runner stops before phase 2 and reports the burst failure.
    expect(outcome.kind).toBe("breakage")
    expect(outcome.phase).toBe("phase-1")
    expect(outcome.accountCount).toBe(2)
    expect(outcome.txSuccesses).toBe(1)
    expect(outcome.txFailures).toBe(1)
    expect(outcome.breakageReason).toBe(
      "phase-1 burst failed: injected phase 1 revert"
    )
    expect(deps.payoutObservers.recipient.observedRequests).toEqual([])
    expect(deps.phase2Requests).toEqual([])
  })

  it("returns saturated when phase 1 metrics saturate even if payout observation fails", async () => {
    // Given: phase 1 envelope metrics saturate and the payout observer times out.
    const deps = createDeps({
      phase1MetricsSaturated: true,
      phase1PayoutFailureReason: "phase 1 payout observer timed out"
    })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: one Ethereum leg is not enough to pass, and payout failure is classified.
    expect(outcome.kind).toBe("breakage")
    expect(outcome.phase).toBe("phase-1")
    expect(outcome.breakageReason).toBe(
      "phase-1 payout observation failed: phase 1 payout observer timed out"
    )
    expect(outcome.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(outcome.phaseResults[0]).toMatchObject({
      phase: "phase-1",
      saturated: true,
      payout: null
    })
    expect(deps.payoutObservers.recipient.observedRequests).toHaveLength(1)
    expect(deps.phase2Requests).toHaveLength(2)
  })

  it("returns saturated from phase 1 destination evidence after payout timeout", async () => {
    // Given: request-side metrics are clean, but the Solana destination metrics saturate.
    const deps = createDeps({
      phase1PayoutFailureReason: "phase 1 payout observer timed out",
      phase1DestinationMetricsSaturated: true
    })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: Solana destination saturation is diagnostic-only and payout failure is classified.
    expect(outcome.kind).toBe("breakage")
    expect(outcome.phase).toBe("phase-1")
    expect(outcome.breakageReason).toBe(
      "phase-1 payout observation failed: phase 1 payout observer timed out"
    )
    expect(outcome.phaseResults[0]?.endpoint).toBe("DEPOT_OUTPOST_SOLANA")
    expect(outcome.envelopeCount).toBe(1)
    expect(outcome.phaseResults[0]?.envelopeByteSizes[0]).toBeGreaterThan(
      SolanaRawTransactionBytesMax
    )
    expect(outcome.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(outcome.phaseResults[0]).toMatchObject({
      phase: "phase-1",
      saturated: true,
      endpoint: "DEPOT_OUTPOST_SOLANA",
      payout: null
    })
    expect(deps.payoutObservers.recipient.observedRequests).toHaveLength(1)
    expect(deps.phase2Requests).toHaveLength(2)
  })

  it("classifies a non-saturated phase 1 payout observation failure as breakage", async () => {
    // Given: the payout observer times out before any saturation is reported.
    const deps = createDeps({
      phase1PayoutFailureReason: "phase 1 payout observer timed out"
    })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: the payout failure is surfaced as classified breakage.
    expect(outcome.kind).toBe("breakage")
    expect(outcome.phase).toBe("phase-1")
    expect(outcome.breakageReason).toBe(
      "phase-1 payout observation failed: phase 1 payout observer timed out"
    )
    expect(outcome.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(deps.payoutObservers.recipient.observedRequests).toHaveLength(1)
    expect(deps.phase2Requests).toHaveLength(2)
  })

  it("continues phase 2 evidence collection after phase 1 payout observation failure", async () => {
    // Given: phase 1 transactions succeed but the WIRE payout observer times out.
    const deps = createDeps({
      phase1PayoutFailureReason: "phase 1 payout observer timed out"
    })

    // When: one iteration runs.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: payout timeout remains breakage, but phase 2 still runs for all-legs evidence.
    expect(outcome.kind).toBe("breakage")
    expect(outcome.phase).toBe("phase-1")
    expect(outcome.breakageReason).toBe(
      "phase-1 payout observation failed: phase 1 payout observer timed out"
    )
    expect(outcome.phaseResults.map(result => result.phase)).toEqual([
      "phase-1",
      "phase-2"
    ])
    expect(deps.phase2Requests).toHaveLength(2)
  })

  it("classifies an impossible zero quote as breakage", async () => {
    // Given: the live reserve snapshot has no ETH-side chain liquidity.
    const deps = createDeps({
      reserveSnapshot: {
        ethereum: { chain: 0n, wire: 1_000_000_000_000n },
        solana: { chain: 1_000_000_000n, wire: 1_000_000_000_000n }
      }
    })

    // When: one iteration tries to compute phase 1 targets.
    const outcome = await createSwapStressPhaseRunner(deps).runIteration(2)

    // Then: the typed quote error is handled as classified breakage.
    expect(outcome.kind).toBe("breakage")
    expect(outcome.phase).toBe("quote")
    expect(outcome.txSuccesses).toBe(0)
    expect(outcome.txFailures).toBe(0)
    expect(outcome.breakageReason).toMatch(/phase-1 quote produced zero/)
  })

  it("reserves one Ethereum nonce block for the whole phase 1 burst", async () => {
    // Given: a phase 1 burst with three concurrent Ethereum submissions.
    const deps = createDeps()

    // When: one iteration runs.
    await createSwapStressPhaseRunner(deps).runIteration(3)

    // Then: nonce allocation reserves the complete burst range up front.
    expect(deps.ethereumNonceReservationCounts).toEqual([3])
  })
})

type TestDeps = SwapStressPhaseRunnerDeps & {
  readonly payoutObservers: {
    readonly recipient: RecordingPayoutObserver
    readonly return: RecordingPayoutObserver
  }
  readonly phase2Requests: Phase2SwapRequest[]
  readonly ethereumNonceReservationCounts: Array<number | undefined>
}

type RecordingPayoutObserver =
  SwapStressPhaseRunnerDeps["recipientPayoutObserver"] & {
    readonly preparedRequests: Parameters<
      SwapStressPhaseRunnerDeps["recipientPayoutObserver"]["waitForPayouts"]
    >[0][]
    readonly observedRequests: Parameters<
      SwapStressPhaseRunnerDeps["recipientPayoutObserver"]["waitForPayouts"]
    >[0][]
  }

type TestDepsOptions = {
  readonly phase1FailureReason?: string
  readonly phase1MetricsSaturated?: boolean
  readonly phase1DestinationMetricsSaturated?: boolean
  readonly phase1PayoutFailureReason?: string
  readonly reserveSnapshot?: SwapStressReservePairSnapshot
}

function createDeps(options: TestDepsOptions = {}): TestDeps {
  const phase2Requests: Phase2SwapRequest[] = [],
    ethereumNonceReservationCounts: Array<number | undefined> = [],
    recipient = recordingPayoutObserver(options),
    returnObserver = recordingPayoutObserver()

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
    readReservePairSnapshot: async () =>
      options.reserveSnapshot ?? defaultReserveSnapshot(),
    getEthereumFirstNonce: async (count?: number) => {
      ethereumNonceReservationCounts.push(count)
      return 9
    },
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
      ) => {
        if (
          options.phase1FailureReason !== undefined &&
          overrides.nonce === 10
        ) {
          throw new Error(options.phase1FailureReason)
        }
        return {
          wait: async () => ({
            status: 1,
            hash: `0x${overrides.nonce}`,
            blockNumber: overrides.nonce,
            gasUsed: BigInt(overrides.nonce)
          })
        }
      }
    },
    submitPhase2Swap: async request => {
      phase2Requests.push(request.request)
      return `sig-${request.index}`
    },
    recipientPayoutObserver: recipient,
    returnPayoutObserver: returnObserver,
    collectEnvelopeMetrics: async request => {
      const saturated =
        request.endpointsType === DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
          ? (options.phase1DestinationMetricsSaturated ?? false)
          : (options.phase1MetricsSaturated ?? false)
      return {
        phase: request.phase,
        saturated,
        envelopeCount: 1,
        envelopeByteSizes: saturated ? [1_767] : [256],
        endpoint: DebugOutpostEndpointsType[request.endpointsType],
        epochStart: 7,
        epochEnd: 8
      }
    },
    clock: fixedClock(),
    concurrency: 2,
    payoutObservers: { recipient, return: returnObserver },
    phase2Requests,
    ethereumNonceReservationCounts
  }
}

function defaultReserveSnapshot(): SwapStressReservePairSnapshot {
  return {
    ethereum: { chain: 1_000_000_000_000n, wire: 1_000_000_000_000n },
    solana: { chain: 1_000_000_000n, wire: 1_000_000_000_000n }
  }
}

function recordingPayoutObserver(
  options: TestDepsOptions = {}
): RecordingPayoutObserver {
  const preparedRequests: RecordingPayoutObserver["preparedRequests"] = [],
    observedRequests: RecordingPayoutObserver["observedRequests"] = []
  return {
    preparedRequests,
    observedRequests,
    preparePayouts: async request => {
      preparedRequests.push(request)
    },
    waitForPayouts: async request => {
      observedRequests.push(request)
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

function fixedClock(): () => number {
  const times = [1_000, 1_010, 1_020, 1_030, 1_040]
  return () => times.shift() ?? 1_050
}
