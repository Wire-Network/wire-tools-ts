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
  SwapStressIterationObservation,
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
): Promise<SwapStressIterationObservation> {
  const clock = deps.clock ?? Date.now
  try {
    assertPositiveCount(count)
    const identities = (deps.createIdentities ?? createStressIdentities)(count),
      phase1Targets = quoteSwapStressPhase1Targets(
        await deps.readReservePairSnapshot(),
        identities.wire.length
      ),
      phase1 = await runPhase1(deps, identities, phase1Targets, clock)
    if (phase1.telemetryDegradation !== null) {
      return breakage({
        phaseResults: [phase1.result],
        reason: phase1.telemetryDegradation.message,
        degradation: phase1.telemetryDegradation.degradation
      })
    }
    if (phase1.burst.failures.length > 0) {
      return breakage({
        phaseResults: [phase1.result],
        reason: burstReason("phase-1", phase1.burst),
        degradation: null
      })
    }
    if (
      phase1.result.payout !== null &&
      phase1.result.payout.observedCount < 1
    ) {
      return breakage({
        phaseResults: [phase1.result],
        reason: "phase-1 payout not observed",
        degradation: null
      })
    }
    const phase2Targets = quoteSwapStressPhase2Targets(
        await deps.readReservePairSnapshot(),
        identities.wire.length
      ),
      phase2 = await runPhase2(deps, identities, phase2Targets, clock),
      phaseResults = [phase1.result, phase2.result]
    if (phase1.batchOperatorFailureReason !== null) {
      return breakage({
        phaseResults,
        reason: `phase-1 batch operator failure: ${phase1.batchOperatorFailureReason}`,
        degradation: null
      })
    }
    if (phase1.payoutFailureReason !== null) {
      return breakage({
        phaseResults,
        reason: `phase-1 payout observation failed: ${phase1.payoutFailureReason}`,
        degradation: null
      })
    }
    if (phase2.telemetryDegradation !== null) {
      return breakage({
        phaseResults,
        reason: phase2.telemetryDegradation.message,
        degradation: phase2.telemetryDegradation.degradation
      })
    }
    if (phase2.burst.failures.length > 0) {
      return breakage({
        phaseResults,
        reason: burstReason("phase-2", phase2.burst),
        degradation: null
      })
    }
    if (phase2.batchOperatorFailureReason !== null) {
      return breakage({
        phaseResults,
        reason: `phase-2 batch operator failure: ${phase2.batchOperatorFailureReason}`,
        degradation: null
      })
    }
    if (phase2.payoutFailureReason !== null) {
      return breakage({
        phaseResults,
        reason: `phase-2 payout observation failed: ${phase2.payoutFailureReason}`,
        degradation: null
      })
    }
    if (
      phase2.result.payout !== null &&
      phase2.result.payout.observedCount < 1
    ) {
      return breakage({
        phaseResults,
        reason: "phase-2 payout not observed",
        degradation: null
      })
    }
    if (phase2.result.saturated) {
      return complete(phaseResults)
    }
    return complete(phaseResults)
  } catch (error) {
    if (error instanceof SwapStressImpossibleQuoteError) {
      return breakage({
        phaseResults: [],
        reason: errorMessage(error),
        degradation: null
      })
    }
    throw error
  }
}

function assertPositiveCount(count: number): void {
  if (!Number.isInteger(count) || count <= 0)
    throw new RangeError("iteration count must be positive")
}
