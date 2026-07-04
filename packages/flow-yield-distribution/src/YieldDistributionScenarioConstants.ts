import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/test-cluster-tool"

/**
 * Constants for the yield-distribution flow. Rewards, share bps, external
 * epoch refs, and timing carry over from the previously-validated jest suite
 * (2026-06): per-staker rewards are sized so the depot's emission-accounting
 * bucket comfortably covers them, the propagation deadline budgets a full
 * emitter → OPP ferry → depot dispatch round trip, and the dedupe settle
 * window derives from the epoch duration so the flow scales with it.
 */
export namespace YieldDistributionScenarioConstants {
  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /** Producer nodes stood up by the bootstrap (the old suite's `producerCount`). */
  export const ProducerCount = 3
  /** Batch operators ferrying OPP envelopes (the old suite's `batchOperatorCount`). */
  export const BatchOperatorCount = 3
  /** Underwriters provisioned by the bootstrap (the old suite's `underwriterCount`). */
  export const UnderwriterCount = 1

  /** The AuthEx-linked staker's WIRE account — its reward lands in `sysio.dclaim::pclaims`. */
  export const LinkedStakerAccount = "yield.lnk"
  /**
   * The emitter's "unlinked" marker: an empty WIRE account makes the depot park
   * the reward in `sysio.dclaim::unmapped` keyed by the staker's native address.
   */
  export const UnlinkedWireAccount = ""

  /** Per-staker ETH-side reward (wei — the depot scales via PrecisionLib). */
  export const EthereumRewardPerStaker = 1_000_000n
  /** Per-staker SOL-side reward (lamports). */
  export const SolanaRewardPerStaker = 1_000_000n
  /** Informational share-in-bps stamped on every emission (100%). */
  export const FullShareBps = 10_000
  /** Informational WIRE epoch index stamped on every emission. */
  export const RewardEpochIndex = 1

  /** The linked staker's `external_epoch_ref` (the old suite's per-run counter, value 1). */
  export const LinkedStakerExternalEpochRef = 1n
  /** The unlinked ETH staker's `external_epoch_ref` (counter value 2). */
  export const UnlinkedStakerExternalEpochRef = 2n
  /** The SOL staker's `external_epoch_ref` (counter value 3). */
  export const SolanaStakerExternalEpochRef = 3n

  /** Registered chain slug code stamped on the SOL-side emission (must match the bootstrap registry seed). */
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Registered token slug code of the SOL-side reward token. */
  export const SolanaTokenCode = SlugName.from("SOL")

  /** Deadline for an attestation to round-trip emitter → batchop ferry → depot
   *  table — a single outpost→depot hop (envelope class). */
  export const PropagationTimeoutMs = ProtocolTiming.SingleHopBudgetMs
  /** Interval between depot-table polls (ms). */
  export const PropagationPollMs = 2_000
  /** Row page size for `sysio.dclaim` table scans (matches the old suite's read limit). */
  export const TableQueryLimit = 5_000
  /** Ceiling on each emit write step (one outpost tx + confirmation). */
  export const EmitStepTimeoutMs = 60_000
  /** Buffer added on top of each poll/settle deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000
  /** Epochs the dedupe verify waits before re-counting `pclaims` (settle window). */
  export const DedupeSettleEpochs = 2

  /**
   * Rejection signature of a replayed `external_epoch_ref` — the
   * `MockYieldEmitter` per-staker monotonic check reverts the tx.
   */
  export const ReplayRejectionPattern = /externalEpochRef not monotonic|reverted/i

  /** Settle window slept before asserting the replayed emission credited nothing. */
  export function dedupeSettleMs(): number {
    return EpochDurationSec * DedupeSettleEpochs * MsPerSecond
  }
}
