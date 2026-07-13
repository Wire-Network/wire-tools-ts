import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the batch-operator-slashing flow. Names, tags, epoch budgets,
 * and envelope fixture values carry over from the previously-validated jest
 * flow (tests/BatchOperatorSlashing.test.ts): three SBP-less dispute operators
 * inject a 3-way divergent split on the contested outpost, three Tier-1 owners
 * vote the canonical checksum, and the non-canonical deliverers are slashed.
 * Every poll deadline derives from the epoch duration so the flow scales with it.
 */
export namespace SlashingScenarioConstants {
  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
  /** Interval for long-running chain-state polls (ms). */
  export const LongPollIntervalMs = 3_000
  /** Interval for the tight epoch-boundary poll (ms). */
  export const BoundaryPollIntervalMs = 1_000
  /**
   * Margin past `next_epoch_start` (in CHAIN time) before injecting the
   * divergent deliveries, so the dispute-opening deliver lands comfortably
   * after the epoch boundary even if block production lags.
   */
  export const EpochBoundaryMarginMs = 2_000

  /**
   * Bootstrapped batch operators provisioned by the harness — enough to keep
   * the rest of the network healthy while the dispute operators drive the
   * contested outpost.
   */
  export const BootstrapBatchOperatorCount = 9
  /**
   * Disable the miss-based termination ladder for the run. The dispute
   * operators are SBP-less and only deliver when the flow injects an envelope,
   * so across the multi-epoch dispute (vote + tally + resolve) they would
   * otherwise accrue enough scheduled-and-missed epochs to trip `termcheck`
   * and flip SLASHED → TERMINATED before the dispute lands — making the slash
   * a no-op on an already-terminated operator. Termination is exercised by
   * flow-batch-operator-termination; THIS flow verifies the dispute-driven
   * slash, which is independent of the miss ladder.
   */
  export const TerminateMaxConsecutiveMisses = 100_000
  /** Companion miss-percentage threshold — effectively disabled (see above). */
  export const TerminateMaxPercentMisses24h = 100

  /**
   * Tier-1 node owners provisioned as the dispute electorate. Names MUST be
   * 2-6 chars — `sysio.roa::valid_name_for_tier` rejects longer Tier-1 names
   * (NAME_INVALID, a soft-fail that never registers and never bumps
   * `nodecount.t1_count`). The bootstrap node owner `wireno` is ALSO Tier-1,
   * so the live `nodecount.t1_count` = these 3 + wireno = 4, and the fast-path
   * quorum is Q = floor(4/2)+1 = 3 — voting all 3 of these owners clears it.
   */
  export const Tier1VoterNames = ["voter1", "voter2", "voter3"] as const

  /**
   * The three batch operators whose divergent deliveries form the split. The
   * operator delivering the canonical tag is the one the Tier-1 owners vote
   * for; the other two are slashed. They are provisioned SBP-less (no daemon)
   * and non-bootstrapped, so the flow fully controls their deliveries.
   */
  export const DisputeOperators = ["dispop.a", "dispop.b", "dispop.c"] as const
  /** The operator delivering the canonical checksum (NOT slashed). */
  export const CanonicalOperator = DisputeOperators[0]
  /** The operators delivering the non-canonical checksums (slashed). */
  export const LosingOperators = [
    DisputeOperators[1],
    DisputeOperators[2]
  ] as const
  /** HD slots for the dispute operators' ETH wallets — past every bootstrapped operator slot. */
  export const DisputeOperatorEthereumHdBase = 35

  /** Distinct payload tags → distinct envelope checksums (no majority). */
  export const EnvelopeTags = ["canonical", "fork-1", "fork-2"] as const
  /**
   * Tag delivered IDENTICALLY by all three dispute operators on the
   * non-contested outpost, so that outpost reaches Option-A consensus for the
   * contested epoch (the post-resolution advance where the slash runs requires
   * every active outpost at epoch consensus).
   */
  export const ConsensusEnvelopeTag = "consensus"

  /** One batch-operator group, so the dispute operators are the SOLE active group. */
  export const DisputeBatchOperatorGroupCount = 1
  /** `epoch_retention_envelope_log_count` for the reshaped epoch config. */
  export const EpochRetentionEnvelopeLogCount = 200

  /**
   * slug_name of the contested outpost. ETHEREUM is one of the two outposts
   * the bootstrap registers + activates; its slug fits a JS number.
   */
  export const ContestedChainCode = SlugName.from("ETHEREUM")
  /**
   * slug_name of the non-contested active outpost (SOLANA) — receives the
   * consistent consensus envelope (see {@link ConsensusEnvelopeTag}).
   */
  export const NonContestedChainCode = SlugName.from("SOLANA")

  /** Envelope fixture: `epoch_envelope_index` (mirrors `sysio.dispute_tests.cpp::encode_envelope`). */
  export const EnvelopeEpochEnvelopeIndex = 1
  /** Envelope fixture: `epoch_timestamp` (mirrors `sysio.dispute_tests.cpp::encode_envelope`). */
  export const EnvelopeEpochTimestampMs = 1_775_612_516_983n
  /** Envelope fixture: message payload version. */
  export const EnvelopeVersion = 0

  /** Row ceiling for `sysio.opreg::operators` reads (bootstrap ops + underwriters + dispute ops). */
  export const OperatorTableReadLimit = 100
  /** Row ceiling for `sysio.chalg::disputes` reads. */
  export const DisputeTableReadLimit = 100
  /** Row ceiling for `sysio.msgch::outpcons` reads (one row per active outpost). */
  export const OutpostConsensusTableReadLimit = 100

  /**
   * Frozen := the epoch index held across ≥ this many consecutive settle polls
   * (the poll interval is ~0.75 epoch, so two stable reads span more than one
   * `epoch_duration_sec` — long enough that a still-advancing epoch would have
   * ticked).
   */
  export const SettleStableChecks = 2
  /** Settle poll interval as a fraction of the epoch duration (see {@link SettleStableChecks}). */
  export const SettlePollIntervalEpochRatio = 0.75

  /** Epochs budgeted for a dispute operator to flip OPERATOR_STATUS_ACTIVE after `processbatch`. */
  export const ActiveEpochBudget = 2
  /** Epochs budgeted for `schbatchgps` to make the dispute operators the sole active group. */
  export const GroupEpochBudget = 5
  /** Epochs budgeted for the epoch index to settle (freeze) on the dispute-operators-owned epoch. */
  export const SettleEpochBudget = 6
  /** Epochs budgeted for the chain head-block time to pass `next_epoch_start`. */
  export const BoundaryEpochBudget = 2
  /**
   * Epochs budgeted for the dispute row to appear. CI-load timing margin: the
   * dispute opens on the 3rd divergent deliver's inline `evalcons` once it
   * lands past `next_epoch_start`. Under CI load the deliver txns + epoch
   * boundary can lag, so the dispute row can appear a little late — 4 epochs
   * (2 raced the boundary and flaked, e.g. run 28108464932). The poll returns
   * the instant the row appears, so a wider ceiling adds no wall-clock to the
   * happy path.
   */
  export const DisputeOpenEpochBudget = 4
  /** Epochs budgeted for the vote tally to resolve the dispute. */
  export const ResolveEpochBudget = 2
  /** Epochs budgeted for the epoch to unpause after resolution. */
  export const UnpauseEpochBudget = 2
  /** Epochs budgeted for the post-resolution advance to slash a non-canonical deliverer. */
  export const SlashPropagationEpochs = 8

  /** Deadline for a dispute operator's ACTIVE flip (ms). */
  export function activeDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      ActiveEpochBudget *
      MsPerSecond
    )
  }

  /** Deadline for the sole-active-group rebuild (ms). */
  export function groupDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      GroupEpochBudget *
      MsPerSecond
    )
  }

  /** Deadline for the frozen-epoch settle (ms). */
  export function settleDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      SettleEpochBudget *
      MsPerSecond
    )
  }

  /** Interval between frozen-epoch settle polls (ms). */
  export function settlePollIntervalMs(): number {
    return (
      Math.floor(EpochDurationSec * SettlePollIntervalEpochRatio) * MsPerSecond
    )
  }

  /** Deadline for the chain clock to pass the epoch boundary (ms). */
  export function boundaryDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      BoundaryEpochBudget *
      MsPerSecond
    )
  }

  /** Deadline for the OPEN dispute row to appear (ms). */
  export function disputeOpenDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      DisputeOpenEpochBudget *
      MsPerSecond
    )
  }

  /** Deadline for the dispute to resolve to the canonical winner (ms). */
  export function resolveDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      ResolveEpochBudget *
      MsPerSecond
    )
  }

  /** Deadline for the epoch to unpause after resolution (ms). */
  export function unpauseDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      UnpauseEpochBudget *
      MsPerSecond
    )
  }

  /** Deadline for a non-canonical deliverer to flip SLASHED (ms). */
  export function slashDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      SlashPropagationEpochs *
      MsPerSecond
    )
  }
}
