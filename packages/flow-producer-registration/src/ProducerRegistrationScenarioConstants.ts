import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { Constants, ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the producer-registration flow.
 *
 * Every deadline derives from {@link ProtocolTiming.effectiveEpochSec} (epochs) or from
 * {@link ProtocolTiming.producerRotationMs} (rounds) — never a stopwatch constant. The
 * distinction matters here more than in most flows: a producer's miss is only observable once
 * its slot comes round again, so the demotion phases are budgeted in ROUNDS while the collateral
 * phases are budgeted in EPOCHS.
 */
export namespace ProducerRegistrationScenarioConstants {
  /** The flow's NON-bootstrapped producer's durable harness handle. */
  export const ProducerLabel = "flowprod"
  /** Anvil-mnemonic HD index for its ETH wallet (past every bootstrap slot). */
  export const ProducerEthereumHdIndex = 36
  /** Lamports airdropped to its SOL keypair (bond + fees headroom). */
  export const ProducerAirdropLamports = 5_000_000_000n

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60

  /**
   * Producer ACCOUNTS in the bootstrap topology: one above the schedule floor.
   *
   * The flow's own producer joins these, so the demotion phase removes one of `floor + 2`
   * schedulable producers and leaves `floor + 1` — strictly ABOVE `min_schedule_size`. At the
   * floor itself `update_ranked_producers` retains the last good schedule rather than publishing
   * a shorter one, and the demoted producer would keep its slot: the assertion would then be
   * ambiguous rather than failing cleanly.
   */
  export const ProducerCount = Constants.MIN_SCHEDULE_SIZE + 1
  /**
   * Producer NODE processes — a different knob from {@link ProducerCount} (`nodeCount` sizes the
   * processes, `producerCount` the accounts fanned across them), set EQUAL so each account
   * carries a distinct signing set.
   */
  export const NodeCount = ProducerCount

  /** Collateral bonded per chain (raw outpost units — wei / lamports). */
  export const BondAmount = 2_000_000n
  /** Per-chain minimum the depot requires of a producer (equal to the bond: exactly sufficient). */
  export const MinimumBond = BondAmount

  /** Registered chain slug codes (must match the bootstrap registry seed). */
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Registered token slug codes. */
  export const EthereumTokenCode = SlugName.from("ETH")
  export const SolanaTokenCode = SlugName.from("SOL")

  /**
   * Consecutive missed rounds that demote a producer — INSTALLED by the flow's `setscorecfg`
   * step, so the demotion assertion is against a threshold the flow set, not one it assumed of
   * the contract's default.
   */
  export const MaxConsecutiveMissedRounds = 3
  /**
   * Fixed-point scale of every score weight — the contract's `producer_rank::score_scale`
   * (basis points; a weight at this value is 100%).
   */
  export const ScoreScale = 10_000
  /**
   * Snapshot attestations within one pay period that earn full marks on the snapshot factor —
   * the contract default.
   */
  export const SnapshotTargetAttestations = 1
  /**
   * Rolling window the miss RATE is measured over — the contract default of a day. The flow never
   * runs long enough to roll it, so every round it observes belongs to one window.
   */
  export const MissedRoundWindowMs = 24 * 60 * 60 * 1_000
  /**
   * Percent of its scheduled rounds a producer may miss inside that window. The flow demotes
   * through the CONSECUTIVE gate, so this is set to the contract default and left alone; it is
   * here because `setscorecfg` installs the whole config, not a subset.
   */
  export const MaxPctMissedRoundsInWindow = 5
  /**
   * Blocks a producer must deliver within its own round for that round to count as served. Set to
   * 0 — the DISABLED spelling — because this flow demotes by stopping a node outright, so every
   * round it charges is a whole round with no blocks at all. Leaving the check armed would make
   * the assertions depend on how many blocks the node happened to land before it died.
   */
  export const MinBlocksPerRound = 0
  /**
   * The `prodscorecfg` the flow installs: the contract's shipped weights around the flow's own
   * demotion threshold. Snapshot service is weighted at a TENTH of collateral, as the contract
   * ships it — it breaks ties rather than outranking a bond. The reserved `relay` / `api` /
   * `benchmark` factors stay at 0.
   */
  export const ScoreConfig: SysioContracts.SysioSystemProducerScoreConfigType = {
    collateral_weight: ScoreScale,
    participation_weight: ScoreScale,
    snapshot_weight: ScoreScale / 10,
    relay_weight: 0,
    api_weight: 0,
    benchmark_weight: 0,
    max_consecutive_missed_rounds: MaxConsecutiveMissedRounds,
    snapshot_target_attestations: SnapshotTargetAttestations,
    missed_round_window_ms: MissedRoundWindowMs,
    max_pct_missed_rounds_in_window: MaxPctMissedRoundsInWindow,
    min_blocks_per_round: MinBlocksPerRound
  }

  /**
   * Withdrawn from the ETH bond in the removal phase — the WHOLE of it.
   *
   * Partial would leave the operator above the minimum and change nothing; the assertion is that
   * dropping BELOW the per-chain minimum takes a producer out of the schedule.
   */
  export const WithdrawAmount = BondAmount

  /** Epochs budgeted for a deposit to relay through OPP and settle on the depot. */
  export const RelayEpochBudget = 9
  /** Rounds budgeted on top of the misses themselves, for the rebuild to publish. */
  export const ScheduleRebuildRoundBudget = 3

  /** Interval for long-running chain-state polls (ms). */
  export const PollIntervalMs = 3_000

  /** Deadline for depot-side relay effects (balance row, status flip). */
  export function relayDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      RelayEpochBudget *
      ProtocolTiming.MsPerSecond
    )
  }

  /**
   * Deadline for a producer to be seen producing a block, or for a schedule rebuild to publish
   * its entry or its exit: the rebuild throttle (a rebuild runs at most once a minute, and the
   * change may have landed just after one) plus the rotations budgeted for the pending schedule
   * to go final and the producer's slot to come round.
   *
   * @param scheduleSize - Producers in the active schedule.
   * @returns The deadline in ms.
   */
  export function scheduleDeadlineMs(scheduleSize: number): number {
    return (
      ProtocolTiming.ScheduleRebuildIntervalMs +
      ProtocolTiming.producerRotationMs(scheduleSize) * ScheduleRebuildRoundBudget
    )
  }

  /**
   * Deadline for `max_consecutive_missed_rounds` misses to accrue and the demotion to publish:
   * the misses themselves, then a full schedule deadline for the rebuild that drops the producer.
   *
   * @param scheduleSize - Producers in the active schedule.
   * @returns The deadline in ms.
   */
  export function demotionDeadlineMs(scheduleSize: number): number {
    return (
      ProtocolTiming.producerRotationMs(scheduleSize) * MaxConsecutiveMissedRounds +
      scheduleDeadlineMs(scheduleSize)
    )
  }
}
