import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { TokenAmount } from "@wireio/opp-typescript-models"
import {
  Constants,
  ProtocolTiming,
  Constants as DepotConstants,
  outputKey
} from "@wireio/cluster-tool"

/**
 * Constants for the producer-registration flow.
 *
 * Every deadline derives from {@link ProtocolTiming.effectiveEpochSec} (epochs) or from
 * {@link ProtocolTiming.producerRotationMs} (rounds) — never a stopwatch constant. The
 * distinction matters here more than in most flows: a producer's miss is only observable once
 * its slot comes round again, so the demotion phases are budgeted in ROUNDS while the score and
 * bond-return phases are budgeted in EPOCHS. Collateral is LIQSOL and LIQETH bonded on the depot through
 * `sysio.opreg::deposit`, each in depot atomic units (9 decimals).
 */
export namespace ProducerRegistrationScenarioConstants {
  /** The flow's NON-bootstrapped producer's durable harness handle. */
  export const ProducerLabel = "flowprod"
  /** Contract assertion proving a producer has not reached collateral admission. */
  export const ProducerAdmissionErrorPattern =
    /producer operator is not eligible for admission/

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

  /**
   * Ad-hoc port pairs this flow reserves: one, for the flow producer's own node.
   *
   * Reserved up front through `adHocCount` rather than picked when the node starts — a pair
   * picked at spawn time never reaches the port registry, so a parallel resolver can hand the
   * same port to a planned daemon before this one binds. The node is stopped and restarted
   * mid-flow and reclaims the SAME pair, so one is enough.
   */
  export const AdHocNodeCount = 1

  /** Each required depot shadow symbol; both entries must be satisfied. */
  export enum CollateralToken {
    Solana = "LIQSOL",
    Ethereum = "LIQETH"
  }
  export const CollateralTokens = [
    CollateralToken.Solana,
    CollateralToken.Ethereum
  ]
  export const FundingAccount = "prodbonder"
  export const Precision = 9

  /** Encode a shadow amount for collateral and remit claims. */
  export function claim(token: CollateralToken, amount: bigint): TokenAmount {
    return TokenAmount.create({
      tokenCode: BigInt(SlugName.from(token)),
      amount
    })
  }

  /** Both shadow symbols are collateral on WIRE, not on their origin chains. */
  export function collateral(token: CollateralToken, amount: bigint) {
    return {
      chain_code: DepotConstants.WireChainCode,
      amount: claim(token, amount)
    }
  }

  /** 2.0 of EACH shadow token, in depot atomic units. */
  export const BondAmount = 2_000_000_000n
  /** Each minimum equals its bond: exactly sufficient only when BOTH are held. */
  export const MinimumBond = BondAmount

  /**
   * Consecutive missed rounds that demote a producer — INSTALLED by the flow's `setscorecfg`
   * step, so the demotion assertion is against a threshold the flow set, not one it assumed of
   * the contract's default.
   */
  export const MaxConsecutiveMissedRounds = 3
  /** Seconds of seniority full snapshot credit is worth — the contract default, three days. */
  export const SnapshotWeightSec = 259_200
  /**
   * Snapshot attestations within one pay period that earn full marks on the snapshot factor —
   * the contract default.
   */
  export const SnapshotTargetAttestations = 1
  /**
   * Blocks a producer must deliver for a round to count as served. Set to 0 — the disabled
   * spelling — because this flow demotes by stopping a node outright, so every round it charges
   * has no blocks at all. Armed, the assertions would depend on how many blocks the node landed
   * before it died.
   */
  export const MinBlocksPerRound = 0
  /**
   * Seconds of seniority an unserved round costs, floored at zero — the contract default, seven
   * days. A served round earns at most one rotation of seniority, so the flow producer holds far
   * less than one penalty when its node stops, and the first round it misses takes all of it.
   */
  export const MissPenaltySec = 604_800
  /**
   * Seconds added to every producer's time term — the contract default, seven days — so a
   * producer with no seniority still scores, and standbys at zero seniority order by stake.
   */
  export const SeniorityBaseSec = 604_800
  /**
   * The `prodscorecfg` the flow installs: the contract's shipped defaults around the flow's own
   * demotion threshold and round verdict. The composite is the collateral multiple M — the lowest
   * bond ÷ minimum across the required pairs, 1x for a bootstrapped producer — times the time
   * term: seniority (`service_sec` in whole hours) plus the snapshot credit plus the seniority
   * base. Collateral both gates admission and multiplies the score; equal composites order by
   * registration. The reserved `relay` / `api` / `benchmark` factors stay at 0.
   */
  export const ScoreConfig: SysioContracts.SysioSystemProducerScoreConfigType =
    {
      snapshot_weight: SnapshotWeightSec,
      relay_weight: 0,
      api_weight: 0,
      benchmark_weight: 0,
      max_consecutive_missed_rounds: MaxConsecutiveMissedRounds,
      snapshot_target_attestations: SnapshotTargetAttestations,
      min_blocks_per_round: MinBlocksPerRound,
      miss_penalty_sec: MissPenaltySec,
      seniority_base_sec: SeniorityBaseSec
    }

  /**
   * The flow producer's registration order, recorded when it registers. The off-schedule pardon
   * must keep it: only a termination or slash takes a new one.
   */
  export const RegistrationOrder = outputKey<
    SysioContracts.SysioSystemProducerInfoType["registration_seq"]
  >(
    "producerRegistration.registrationOrder",
    "the flow producer's registration order, taken when it registered"
  )

  /**
   * Withdrawn from the bond in the removal phase — the WHOLE of it.
   *
   * Each bond is exactly at its minimum; dropping either below that minimum removes eligibility.
   */
  export const WithdrawAmount = BondAmount

  /** Epochs budgeted for registration's score to land in the healthy tier. */
  export const ScoreEpochBudget = 9
  /** Rounds budgeted on top of the misses themselves, for the rebuild to publish. */
  export const ScheduleRebuildRoundBudget = 3

  /** Interval for long-running chain-state polls (ms). */
  export const PollIntervalMs = 3_000

  /** Deadline for registration's score to land in the healthy tier (ms). */
  export function scoreDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      ScoreEpochBudget *
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
      ProtocolTiming.producerRotationMs(scheduleSize) *
        ScheduleRebuildRoundBudget
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
      ProtocolTiming.producerRotationMs(scheduleSize) *
        MaxConsecutiveMissedRounds +
      scheduleDeadlineMs(scheduleSize)
    )
  }
}
