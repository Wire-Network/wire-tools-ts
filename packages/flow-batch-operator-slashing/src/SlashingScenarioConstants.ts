import { SlugName } from "@wireio/sdk-core"
import {
  Constants,
  ManagedProcess,
  MinBatchOperatorGroups,
  NodeopProcess,
  ProtocolTiming
} from "@wireio/cluster-tool"

/**
 * Constants for the batch-operator-slashing flow. Names, tags, epoch budgets,
 * and envelope fixture values carry over from the previously-validated jest
 * flow (tests/BatchOperatorSlashing.test.ts): three SBP-less dispute operators
 * inject a 3-way divergent split on the contested outpost, three Tier-1 owners
 * vote the canonical checksum, and the non-canonical deliverers are slashed.
 * Every poll deadline derives from the epoch duration so the flow scales with it.
 */
export namespace SlashingScenarioConstants {
  /** Consensus epoch duration (s) of every outpost chain. */
  export const EpochDurationSec = 60
  /**
   * Economic epoch duration (s) — the `sysio.epoch::seteconomy` floor, equal to the consensus
   * epoch. The economic clock keeps opening epochs while the dispute pauses consensus, so this
   * sizes the waits of the economic-clock phase.
   */
  export const EconomicEpochDurationSec = 60
  /** Economic epochs each economic-clock observation during the dispute awaits. */
  export const EconomicEpochsPerObservation = 1
  /** The economic-clock observation taken while the dispute pauses consensus. */
  export const DisputePauseObservation = "dispute-pause"
  /** The economic-clock observation taken after every batch-operator relay restarted. */
  export const RelayRestartObservation = "relay-restart"
  /** Ceiling on stopping one relay: its graceful stop window plus the step margin (ms). */
  export const RelayStopTimeoutMs =
    ManagedProcess.GracefulKillMs + ProtocolTiming.PollDeadlineBufferMs
  /**
   * Launches `NodeopProcess.startWithRecovery` may make for one relay: the start, and the
   * hard-replay restart it falls back to when the retained data is dirty.
   */
  export const RelayStartAttempts = 2
  /**
   * Ceiling on starting one relay against its retained data: every launch within the node's
   * readiness window, plus the step margin (ms).
   */
  export const RelayStartTimeoutMs =
    RelayStartAttempts * NodeopProcess.StartupTimeoutMs +
    ProtocolTiming.PollDeadlineBufferMs
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
  /** Interval for long-running chain-state polls (ms). */
  export const LongPollIntervalMs = 3_000
  /** Interval for the tight epoch-boundary poll (ms). */
  export const BoundaryPollIntervalMs = 1_000

  /**
   * The three batch operators whose divergent deliveries form the split. The
   * operator delivering the canonical tag is the one the Tier-1 owners vote
   * for; the other two are slashed. They are provisioned SBP-less (no daemon)
   * and non-bootstrapped, so the flow fully controls their deliveries.
   */
  export const DisputeOperators = ["dispop.a", "dispop.b", "dispop.c"] as const
  /** Group SIZE the dispute needs — three divergent deliveries, no majority. */
  export const DisputeOperatorCount = DisputeOperators.length
  /**
   * Batch-operator groups per chain: the depot's floor. The advance after the
   * dispute operators turn ACTIVE seats them as the window's new tail, and the
   * advance after that makes them the contested chain's SOLE active group.
   */
  export const DisputeBatchOperatorGroupCount = MinBatchOperatorGroups
  /**
   * Bootstrapped batch operators provisioned by the harness — one window of
   * {@link DisputeBatchOperatorGroupCount} groups of {@link DisputeOperators}.length,
   * because the scenario states the group shape EXPLICITLY (`operatorsPerEpoch` +
   * `batchOpGroups` in its `defaults`) and the bootstrap's
   * `sysio.epoch::schbatchgps` asserts the ACTIVE pool can fill that shape:
   * `operators_per_epoch x batch_op_groups` operators must exist when it runs. A
   * smaller roster reverts the bootstrap with "not enough available batch
   * operators for group assignment".
   *
   * These bootstrapped operators leave the contested chain's window as it slides:
   * each advance draws the new tail group from the chain's pool, non-bootstrapped
   * first, so the advance after the flow flips the SBP-less dispute operators
   * ACTIVE seats the three `dispop.*` (which serve only the contested chain) as
   * the tail, and the advance after that brings them on duty, as
   * `SlashingScenario.plan` describes. The bootstrapped operators keep relaying the
   * contested chain until then, and the other chain for the whole run.
   */
  export const BootstrapBatchOperatorCount =
    DisputeOperatorCount * DisputeBatchOperatorGroupCount
  /**
   * Loosest VALID termination thresholds for the run. Termination CANNOT be
   * fully disabled — the depot contract (`sysio.opreg::setconfig`) caps
   * `terminate_max_consecutive_misses` at [1, 5], `terminate_max_pct_misses_24h`
   * at [1, 99] and `terminate_min_pct_samples` at [1, 100] — so the run takes the
   * max the contract allows: this consecutive-miss ceiling,
   * `ClusterBuildDefaults.MaxTerminateMaxPercentMisses24h` for the percentage, and
   * `ClusterBuildDefaults.MaxTerminateMinimumPercentSamples` for the duty epochs the
   * percent rail waits for. The dispute operators
   * are SBP-less and only deliver when the flow injects an envelope; across the
   * critical window the contested chain's epoch FREEZES (the sole active group
   * isn't delivering, so its consensus can't advance) and then PAUSES
   * (opendispute), so its `advance` — and thus `recorddel` miss-recording — does
   * not run during settle / vote / tally / resolve. The dispute ops serve no other
   * chain, so they never accrue 5 consecutive missed ADVANCES, and at the loosest
   * valid thresholds they don't trip `termcheck` (which would evict them from the
   * contested chain) before the slash lands. Termination itself is exercised by
   * flow-batch-operator-termination; THIS flow verifies the dispute-driven slash,
   * independent of the miss ladder.
   */
  export const TerminateMaxConsecutiveMisses = 5

  /**
   * Tier-1 node owners that vote the dispute. Names MUST be 2-6 chars —
   * `sysio.roa::valid_name_for_tier` rejects longer Tier-1 names (NAME_INVALID,
   * a soft-fail that never registers and never bumps `nodecount.t1_count`).
   */
  export const Tier1VoterNames = ["voter1", "voter2", "voter3"] as const
  /**
   * A Tier-1 node owner that never votes. It makes the electorate 4, so the
   * fast-path quorum is Q = floor(4/2)+1 = 3 and the dispute resolves only once
   * every one of {@link Tier1VoterNames} has voted.
   */
  export const Tier1AbstainerName = "abstn"
  /** The dispute electorate: every Tier-1 node owner the flow registers. */
  export const Tier1ElectorateNames = [
    ...Tier1VoterNames,
    Tier1AbstainerName
  ] as const

  /** The operator delivering the canonical checksum (NOT slashed). */
  export const CanonicalOperator = DisputeOperators[0]
  /** The operators delivering the non-canonical checksums (slashed). */
  export const LosingOperators = [
    DisputeOperators[1],
    DisputeOperators[2]
  ] as const

  /** Distinct payload tags → distinct envelope checksums (no majority). */
  export const EnvelopeTags = ["canonical", "fork-1", "fork-2"] as const

  /** `epoch_retention_envelope_log_count` for the reshaped epoch config. */
  export const EpochRetentionEnvelopeLogCount = 200

  /**
   * The contested outpost chain. It runs its own consensus epoch, so the dispute
   * pauses it alone: the dispute operators serve only it, and the other chain
   * keeps advancing with the bootstrapped operators.
   */
  export const ContestedChain = Constants.ETHEREUM_CHAIN_CODENAME
  /** The contested outpost's packed slug_name; it fits a JS number. */
  export const ContestedChainCode = SlugName.from(ContestedChain)
  /**
   * The outpost chain the dispute leaves running: its bootstrapped operators keep
   * relaying it while the contested chain is paused.
   */
  export const RunningChain = Constants.SOLANA_CHAIN_CODENAME

  /** Envelope fixture: `epoch_envelope_index` (mirrors `sysio.dispute_tests.cpp::encode_envelope`). */
  export const EnvelopeEpochEnvelopeIndex = 1
  /** Envelope fixture: `epoch_timestamp` (mirrors `sysio.dispute_tests.cpp::encode_envelope`). */
  export const EnvelopeEpochTimestampMs = 1_775_612_516_983n
  /** V1 fixture accepted by depot admission before the dispute checks. */
  export const EnvelopeVersion = 1

  /** Row ceiling for `sysio.opreg::operators` reads (bootstrap ops + underwriters + dispute ops). */
  export const OperatorTableReadLimit = 100
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

  /**
   * Share of a minimum epoch that must remain, in chain time, before the contested
   * chain is due when the dispute operators' ACTIVE flips start. An advance never
   * lands before the chain is due and an idle chain is never due, so all three flips
   * land between the same two advances unless they take longer than this.
   */
  export const ActivationHeadroomEpochRatio = 0.5
  /**
   * Epochs budgeted for the contested chain to be idle or leave
   * {@link activationHeadroomMs} before it is due: the epoch then live, if traffic
   * already made it due, and the next.
   */
  export const ActivationHeadroomEpochBudget = 2
  /** Epochs budgeted for a dispute operator to flip OPERATOR_STATUS_ACTIVE after `processbatch`. */
  export const ActiveEpochBudget = 2
  /**
   * Epochs budgeted, from the moment all three dispute operators are ACTIVE, for
   * the contested chain's advances to make them its sole active group: the
   * keep-due traffic the await gives it makes it due within one minimum of each
   * epoch's start, so one advance seats them as the tail and the next, once the
   * bootstrapped group ahead of them has relayed its epoch, brings them on duty;
   * one more for the traffic's own landing.
   */
  export const GroupEpochBudget = DisputeBatchOperatorGroupCount + 1
  /** Epochs budgeted for the epoch index to settle (freeze) on the dispute-operators-owned epoch. */
  export const SettleEpochBudget = 6
  /**
   * Epochs budgeted for the dispute row to appear. The dispute opens in the
   * transaction of the 3rd divergent delivery, the one after which no version
   * can still win, through its inline `evalcons`. Under CI load the delivery
   * transactions can land late. The poll returns the instant the row appears,
   * so a wider ceiling adds no wall-clock to the happy path.
   */
  export const DisputeOpenEpochBudget = 4
  /** Epochs budgeted for the vote tally to resolve the dispute. */
  export const ResolveEpochBudget = 2
  /** Epochs budgeted for the epoch to unpause after resolution. */
  export const UnpauseEpochBudget = 2
  /**
   * Epochs budgeted for a non-canonical deliverer to read SLASHED once the dispute
   * has resolved. The resolving `chkdispute` transaction slashes it, so the poll
   * normally returns on its first read.
   */
  export const SlashEpochBudget = 1
  /**
   * Epochs budgeted, from the traffic the resolution gives the contested chain
   * (`sysio.msgch::resolvedisp`), for the chain to fall due: its traffic wait, at most
   * one minimum, plus the delivery extension.
   */
  export const ContestedDueEpochBudget = 1

  /** Chain-clock headroom before the contested chain is due that the ACTIVE flips start with (ms). */
  export function activationHeadroomMs(): number {
    return EpochDurationSec * ActivationHeadroomEpochRatio * MsPerSecond
  }

  /** Deadline for the contested chain to be idle or leave {@link activationHeadroomMs} before it is due (ms). */
  export function activationHeadroomDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      ActivationHeadroomEpochBudget *
      MsPerSecond
    )
  }

  /** Deadline for a dispute operator's ACTIVE flip (ms). */
  export function activeDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      ActiveEpochBudget *
      MsPerSecond
    )
  }

  /** Deadline for the contested chain's next advance to seat the dispute operators as its sole group (ms). */
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

  /** Deadline for a non-canonical deliverer to read SLASHED once the dispute has resolved (ms). */
  export function slashDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      SlashEpochBudget *
      MsPerSecond
    )
  }

  /** Deadline for the contested chain to fall due after the resolution's traffic (ms). */
  export function contestedDueDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      ContestedDueEpochBudget *
      MsPerSecond
    )
  }
}
