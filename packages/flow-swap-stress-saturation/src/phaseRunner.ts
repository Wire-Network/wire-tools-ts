import { DebugOutpostEndpointsType } from "@wireio/opp-typescript-models"

import { runEthereumSwapBurst, runSolanaSwapBurst } from "./boundedBursts.js"
import {
  buildPayoutRequest,
  buildPhase1Requests,
  buildPhase2Requests
} from "./phaseRunnerRequests.js"
import { quoteSwapStressPhase1, quoteSwapStressPhase2 } from "./phaseQuotes.js"
import { createStressIdentities } from "./stressIdentities.js"
import {
  complete,
  breakage,
  burstReason,
  collectMetrics,
  errorMessage,
  phaseResult,
  type PhaseRun
} from "./phaseRunnerOutcomes.js"
import {
  SwapStressImpossibleQuoteError,
  SwapStressPhaseAmounts
} from "./phaseRunnerTypes.js"
import type { SwapStressPhaseQuote } from "./phaseQuotes.js"
import type { StressIdentities } from "./stressIdentities.js"
import type {
  SwapStressIterationOutcome,
  SwapStressPhase,
  SwapStressPhaseRunner,
  SwapStressPhaseRunnerDeps
} from "./phaseRunnerTypes.js"

/**
 * Create a dependency-injected runner for one swap stress saturation iteration.
 *
 * @param deps Chain, quote, burst, payout, and telemetry collaborators.
 * @returns Testable `runIteration(count)` runner.
 */
export function createSwapStressPhaseRunner(
  deps: SwapStressPhaseRunnerDeps
): SwapStressPhaseRunner {
  return { runIteration: count => runIteration(deps, count) }
}

async function runIteration(
  deps: SwapStressPhaseRunnerDeps,
  count: number
): Promise<SwapStressIterationOutcome> {
  const clock = deps.clock ?? Date.now,
    startedAtMs = clock()
  try {
    assertPositiveCount(count)
    const identities = (deps.createIdentities ?? createStressIdentities)(count),
      phase1 = await runPhase1(
        deps,
        identities,
        quoteSwapStressPhase1(await deps.readReservePairSnapshot()),
        clock
      )
    if (phase1.burst.failures.length > 0) {
      return breakage(
        count,
        "phase-1",
        startedAtMs,
        clock(),
        phase1.result,
        burstReason("phase-1", phase1.burst)
      )
    }
    if (
      phase1.result.payout !== null &&
      phase1.result.payout.observedCount < 1
    ) {
      return breakage(
        count,
        "phase-1",
        startedAtMs,
        clock(),
        phase1.result,
        "phase-1 payout not observed"
      )
    }
    const phase2 = await runPhase2(
        deps,
        identities,
        quoteSwapStressPhase2(await deps.readReservePairSnapshot()),
        clock
      ),
      phaseResults = [phase1.result, phase2.result]
    if (phase1.batchOperatorFailureReason !== null) {
      return breakage(
        count,
        "phase-1",
        startedAtMs,
        clock(),
        phaseResults,
        `phase-1 batch operator failure: ${phase1.batchOperatorFailureReason}`
      )
    }
    if (phase1.payoutFailureReason !== null) {
      return breakage(
        count,
        "phase-1",
        startedAtMs,
        clock(),
        phaseResults,
        `phase-1 payout observation failed: ${phase1.payoutFailureReason}`
      )
    }
    if (phase2.burst.failures.length > 0) {
      return breakage(
        count,
        "phase-2",
        startedAtMs,
        clock(),
        phaseResults,
        burstReason("phase-2", phase2.burst)
      )
    }
    if (phase2.batchOperatorFailureReason !== null) {
      return breakage(
        count,
        "phase-2",
        startedAtMs,
        clock(),
        phaseResults,
        `phase-2 batch operator failure: ${phase2.batchOperatorFailureReason}`
      )
    }
    if (phase2.payoutFailureReason !== null) {
      return breakage(
        count,
        "phase-2",
        startedAtMs,
        clock(),
        phaseResults,
        `phase-2 payout observation failed: ${phase2.payoutFailureReason}`
      )
    }
    if (
      phase2.result.payout !== null &&
      phase2.result.payout.observedCount < 1
    ) {
      return breakage(
        count,
        "phase-2",
        startedAtMs,
        clock(),
        phaseResults,
        "phase-2 payout not observed"
      )
    }
    if (phase2.result.saturated) {
      return complete(count, startedAtMs, clock(), phaseResults)
    }
    return complete(count, startedAtMs, clock(), phaseResults)
  } catch (error) {
    if (error instanceof SwapStressImpossibleQuoteError) {
      return breakage(
        count,
        "quote",
        startedAtMs,
        clock(),
        [],
        errorMessage(error)
      )
    }
    throw error
  }
}

async function runPhase1(
  deps: SwapStressPhaseRunnerDeps,
  identities: StressIdentities,
  quote: SwapStressPhaseQuote,
  clock: () => number
): Promise<PhaseRun> {
  const phaseStartedAtMs = clock(),
    payoutRequest = buildPayoutRequest(
      "phase-1",
      identities.wire.map(identity => ({
        index: identity.index,
        address: identity.account
      })),
      quote.wireIntermediate
    )
  await deps.recipientPayoutObserver.preparePayouts?.(payoutRequest)
  const phase1Requests = buildPhase1Requests(
      deps.route,
      identities,
      quote.wireIntermediate
    ),
    burst = await runEthereumSwapBurst({
      reserveManager: deps.ethereumReserveManager,
      requests: phase1Requests,
      firstNonce: await deps.getEthereumFirstNonce(phase1Requests.length),
      concurrency: deps.concurrency
    })
  const metrics = await collectMetrics(
    deps,
    "phase-1",
    phaseStartedAtMs,
    clock()
  )
  let payout: PhaseRun["result"]["payout"] = null,
    payoutFailureReason: string | null = null,
    batchOperatorFailureReason: string | null = null
  if (burst.failures.length === 0) {
    try {
      payout = await deps.recipientPayoutObserver.waitForPayouts(payoutRequest)
    } catch (error) {
      payoutFailureReason =
        error instanceof Error ? error.message : String(error)
      batchOperatorFailureReason = await detectBatchOperatorFailure(
        deps,
        "phase-1",
        phaseStartedAtMs,
        clock(),
        payoutFailureReason
      )
    }
  }
  if (payoutFailureReason !== null && !metrics.saturated) {
    const sourceMetrics = await collectMetrics(
      deps,
      "phase-1",
      phaseStartedAtMs,
      clock(),
      DebugOutpostEndpointsType.OUTPOST_ETHEREUM_DEPOT
    )
    if (sourceMetrics.saturated) {
      const sourceEndedAtMs = clock()
      return {
        burst,
        result: phaseResult(
          "phase-1",
          burst,
          null,
          sourceMetrics,
          phaseStartedAtMs,
          sourceEndedAtMs
        ),
        payoutFailureReason,
        batchOperatorFailureReason
      }
    }
    const destinationMetrics = await collectMetrics(
      deps,
      "phase-1",
      phaseStartedAtMs,
      clock(),
      DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA
    )
    if (destinationMetrics.saturated) {
      const destinationEndedAtMs = clock()
      return {
        burst,
        result: phaseResult(
          "phase-1",
          burst,
          null,
          destinationMetrics,
          phaseStartedAtMs,
          destinationEndedAtMs
        ),
        payoutFailureReason,
        batchOperatorFailureReason
      }
    }
  }
  const endedAtMs = clock()
  return {
    burst,
    result: phaseResult(
      "phase-1",
      burst,
      payout,
      metrics,
      phaseStartedAtMs,
      endedAtMs
    ),
    payoutFailureReason,
    batchOperatorFailureReason
  }
}

async function runPhase2(
  deps: SwapStressPhaseRunnerDeps,
  identities: StressIdentities,
  quote: SwapStressPhaseQuote,
  clock: () => number
): Promise<PhaseRun> {
  const phaseStartedAtMs = clock(),
    targetWei = quote.targetAmount * SwapStressPhaseAmounts.EthWeiPerDepotUnit,
    payoutRequest = buildPayoutRequest(
      "phase-2",
      identities.ethereum.map(identity => ({
        index: identity.index,
        address: identity.address
      })),
      targetWei
    )
  await deps.returnPayoutObserver.preparePayouts?.(payoutRequest)
  const burst = await runSolanaSwapBurst({
    requests: buildPhase2Requests(deps.route, identities, quote.targetAmount),
    concurrency: deps.concurrency,
    submit: deps.submitPhase2Swap
  })
  let payout: PhaseRun["result"]["payout"] = null,
    payoutFailureReason: string | null = null,
    batchOperatorFailureReason: string | null = null
  if (burst.failures.length === 0) {
    try {
      payout = await deps.returnPayoutObserver.waitForPayouts(payoutRequest)
    } catch (error) {
      payoutFailureReason =
        error instanceof Error ? error.message : String(error)
      batchOperatorFailureReason = await detectBatchOperatorFailure(
        deps,
        "phase-2",
        phaseStartedAtMs,
        clock(),
        payoutFailureReason
      )
    }
  }
  const endedAtMs = clock()
  const metrics = await collectMetrics(
    deps,
    "phase-2",
    phaseStartedAtMs,
    endedAtMs
  )
  return {
    burst,
    result: phaseResult(
      "phase-2",
      burst,
      payout,
      metrics,
      phaseStartedAtMs,
      endedAtMs
    ),
    payoutFailureReason,
    batchOperatorFailureReason
  }
}

async function detectBatchOperatorFailure(
  deps: SwapStressPhaseRunnerDeps,
  phase: SwapStressPhase,
  startedAtMs: number,
  endedAtMs: number,
  payoutFailureReason: string
): Promise<string | null> {
  return deps.batchOperatorFailureProbe === undefined
    ? null
    : deps.batchOperatorFailureProbe({
        phase,
        startedAtMs,
        endedAtMs,
        payoutFailureReason
      })
}

function assertPositiveCount(count: number): void {
  if (!Number.isInteger(count) || count <= 0)
    throw new RangeError("iteration count must be positive")
}
