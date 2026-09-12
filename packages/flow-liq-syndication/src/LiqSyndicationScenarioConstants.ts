import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the liq-syndication flow. The topology mirrors
 * `flow-yield-distribution` — the other flow that drives synthetic
 * attestations through `liqsol_core::add_attestation` — so the envelope-ferry
 * path under test is the already-validated one. Amounts are liqSOL base units
 * (9 decimals, 1:1 with the depot frame), and every deadline derives from
 * {@link ProtocolTiming} rather than a stopwatch.
 */
export namespace LiqSyndicationScenarioConstants {
  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /** Producer nodes stood up by the bootstrap. */
  export const ProducerCount = 3
  /** Batch operators ferrying OPP envelopes (the group that must relay the injections). */
  export const BatchOperatorCount = 3
  /** Underwriters provisioned by the bootstrap. */
  export const UnderwriterCount = 1

  /** Registered chain slug code of the Solana outpost (must match the bootstrap registry seed). */
  export const SolanaChainCode = SlugName.from("SOLANA")

  /** liqSOL syndicated by the injected `SyndicateLiq` (1 liqSOL in base units). */
  export const SyndicatedAmount = 1_000_000_000n
  /** liqSOL reported by the injected `LiqYield` (0.025 liqSOL in base units). */
  export const ReportedYieldAmount = 25_000_000n

  /**
   * `sequence` values for the two injections. ONE per-outpost strictly-increasing
   * counter is shared by `SyndicateLiq` and `LiqYield`, so these must differ and
   * ascend in emission order.
   */
  export const SyndicateSequence = 1n
  /** See {@link SyndicateSequence} — the next value on the shared counter. */
  export const LiqYieldSequence = 2n

  /** Outpost-chain epoch stamped on the injected `LiqYield` (informational on the depot). */
  export const ReportedSolanaEpoch = 1n

  /** Deadline for an injected attestation to reach an OUTPOST_SOLANA_DEPOT
   *  envelope — a single outpost→depot hop (envelope class). */
  export const CirculationTimeoutMs = ProtocolTiming.SingleHopBudgetMs
  /** Interval between opp-debugging artifact scans (ms). */
  export const CirculationPollMs = 2_000

  /** Ceiling on each injection write step (one test-validator tx + confirmation). */
  export const EmitStepTimeoutMs = ProtocolTiming.OutpostWriteBudgetMs

  /**
   * Effective-epoch windows budgeted for `current_epoch_index` to move past the
   * pre-injection snapshot. Reuses the shared epoch-advance liveness envelope —
   * the depot must keep advancing WHILE carrying envelopes with attestation
   * types its dispatcher does not know.
   */
  export const EpochAdvanceEpochBudget = ProtocolTiming.EpochVerifyEpochCount
  /** Interval between epoch-state reads while waiting for the advance (ms). */
  export const EpochAdvancePollMs = ProtocolTiming.EpochVerifyPollIntervalMs

  /** Row page size for the `sysio.epoch::epochstate` singleton read. */
  export const EpochStateQueryLimit = 1

  /** Deadline for the depot to advance past the snapshotted epoch index (ms). */
  export function epochAdvanceDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      EpochAdvanceEpochBudget *
      ProtocolTiming.MsPerSecond
    )
  }
}
