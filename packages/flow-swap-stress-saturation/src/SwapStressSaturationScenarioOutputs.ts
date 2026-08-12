import { outputKey, type OutputKey } from "@wireio/cluster-tool"

import type { EnvelopeBaselineIdentity } from "./envelope-integrity/index.js"
import type {
  BurstResult,
  StressIdentities,
  SwapStressPayoutObservationRequest
} from "./swap-stress/index.js"

/**
 * Typed cross-step outputs for the swap-stress saturation scenario.
 *
 * The campaign is a Phase per ramp rung, and each rung's Steps accumulate into
 * ONE record keyed by rung index — the sanctioned cross-step channel, never a
 * closure over scenario state. The closing verification reads every rung back
 * to decide whether both required Ethereum directions saturated.
 */
export namespace SwapStressSaturationScenarioOutputs {
  /**
   * Which leg of a rung a Step operates on. Phase 1 drives Ethereum→WIRE and
   * measures the outpost→depot direction; phase 2 drives WIRE→Ethereum and
   * measures depot→outpost.
   */
  export enum RungPhaseSlot {
    phase1 = "phase1",
    phase2 = "phase2"
  }

  /** One phase's accumulation, mutated in order by that phase's Steps. */
  export interface RungPhaseState {
    /** Window start, read BEFORE the baseline capture it must span. */
    startedAtMs: number
    /** Captured pre-burst baseline identity, or null when degraded. */
    baselineIdentity: EnvelopeBaselineIdentity | null
    /** Sidecar keys that already existed before this phase. */
    baseKeys: readonly string[]
    /** Whether baseline capture or metric collection exhausted its deadline. */
    telemetryDegraded: boolean
    /** Submitted burst outcome, or null when the phase never bursted. */
    burst: BurstResult | null
    /** The payout delta request this phase prepared. */
    payoutRequest: SwapStressPayoutObservationRequest | null
    /** Payouts actually observed, or null when the wait was skipped. */
    payoutObservedCount: number | null
    /** Recorded (never thrown) payout failure — see the rung verify Step. */
    payoutFailureReason: string | null
    /** Batch-operator failure correlated to this phase's window. */
    batchOperatorFailureReason: string | null
    /** Whether this phase's envelopes met the saturation byte gate. */
    saturated: boolean
    /** `DebugOutpostEndpointsType` member NAME this phase measures. */
    endpointName: string
    /** Envelopes selected into this phase's window. */
    envelopeCount: number
  }

  /**
   * One rung's cross-Step state.
   *
   * Deliberately mutable: the rung's nine Steps accumulate into a single
   * record on `ctx.outputs`. Steps are constructed before anything runs, so
   * they cannot capture scenario state — this record IS the channel.
   */
  export interface RungState {
    /** Zero-based position in the ramp curve. */
    readonly rungIndex: number
    /** Stress accounts participating in this rung. */
    readonly accountCount: number
    /** Set when an earlier rung already saturated both required endpoints. */
    skipped: boolean
    /** Deterministic identity slice, computed once per rung. */
    identities: StressIdentities | null
    /** Ethereum→WIRE leg. */
    phase1: RungPhaseState
    /** WIRE→Ethereum leg. */
    phase2: RungPhaseState
  }

  /**
   * The per-rung state handle.
   *
   * `OutputStore` keys by NAME, so this is a pure function of the rung index —
   * a Step's named runner can re-derive its rung's key from its typed input
   * without the factory closing over anything.
   *
   * @param rungIndex - Zero-based position in the ramp curve.
   * @returns The typed output key for that rung's accumulated state.
   */
  export function rungStateKey(rungIndex: number): OutputKey<RungState> {
    return outputKey<RungState>(
      `stressSaturation.rung.${rungIndex}`,
      `ramp rung ${rungIndex} accumulated phase state`
    )
  }
}
