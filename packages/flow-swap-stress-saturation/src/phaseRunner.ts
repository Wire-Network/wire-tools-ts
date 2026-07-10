import {
  quoteSwapStressPhase1Targets,
  quoteSwapStressPhase2Targets
} from "./phaseQuotes.js"
import { createStressIdentities } from "./stressIdentities.js"
import {
  complete,
  breakage,
  burstReason,
  errorMessage
} from "./phaseRunnerOutcomes.js"
import { runPhase1 } from "./phaseRunnerPhase1.js"
import { runPhase2 } from "./phaseRunnerPhase2.js"
import { SwapStressImpossibleQuoteError } from "./phaseRunnerTypes.js"
import type {
  SwapStressIterationOutcome,
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
      phase1Targets = quoteSwapStressPhase1Targets(
        await deps.readReservePairSnapshot(),
        identities.wire.length
      ),
      phase1 = await runPhase1(
        deps,
        identities,
        phase1Targets,
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
    const phase2Targets = quoteSwapStressPhase2Targets(
        await deps.readReservePairSnapshot(),
        identities.wire.length
      ),
      phase2 = await runPhase2(deps, identities, phase2Targets, clock),
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
    if (phase2.metricsFailureReason !== null) {
      return breakage(
        count,
        "phase-2",
        startedAtMs,
        clock(),
        phaseResults,
        `phase-2 metrics collection failed: ${phase2.metricsFailureReason}`
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

function assertPositiveCount(count: number): void {
  if (!Number.isInteger(count) || count <= 0)
    throw new RangeError("iteration count must be positive")
}
