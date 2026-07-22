import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"
import {
  type Phase2SwapRequest,
  type SwapStressPhaseRunnerDeps,
  type SwapStressReservePairSnapshot
} from "@wireio/test-flow-swap-stress-saturation"

import { strictSnapshotMetrics } from "./phaseRunnerMetricFixtures.js"

type RecordingPayoutObserver =
  SwapStressPhaseRunnerDeps["recipientPayoutObserver"] & {
    readonly preparedRequests: Parameters<
      SwapStressPhaseRunnerDeps["recipientPayoutObserver"]["waitForPayouts"]
    >[0][]
    readonly observedRequests: Parameters<
      SwapStressPhaseRunnerDeps["recipientPayoutObserver"]["waitForPayouts"]
    >[0][]
  }

export type PhaseRunnerTestDeps = Extract<
  SwapStressPhaseRunnerDeps,
  { readonly telemetryKind: "synthetic" }
> & {
  readonly payoutObservers: {
    readonly recipient: RecordingPayoutObserver
    readonly return: RecordingPayoutObserver
  }
  readonly phase2Requests: Phase2SwapRequest[]
  readonly ethereumNonceReservationCounts: Array<number | undefined>
}

type TestDepsOptions = {
  readonly phase1FailureReason?: string
  readonly phase1MetricsSaturated?: boolean
  readonly phase1DestinationMetricsSaturated?: boolean
  readonly phase1PayoutFailureReason?: string
  readonly reserveSnapshot?: SwapStressReservePairSnapshot
}

/**
 * Build deterministic phase-runner dependencies for behavior tests.
 * @param options Failure and saturation controls for the fixture.
 * @returns Recording collaborators and the typed runner dependency surface.
 */
export function createDeps(options: TestDepsOptions = {}): PhaseRunnerTestDeps {
  const phase2Requests: Phase2SwapRequest[] = [],
    ethereumNonceReservationCounts: Array<number | undefined> = [],
    recipient = recordingPayoutObserver(options),
    returnObserver = recordingPayoutObserver()

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
      return strictSnapshotMetrics({
        phase: request.phase,
        saturated,
        envelopeCount: 1,
        envelopeByteSizes: saturated ? [1_767] : [256],
        endpoint: DebugOutpostEndpointsType[request.endpointsType],
        epochStart: "7",
        epochEnd: "8"
      })
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
