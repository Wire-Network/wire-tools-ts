import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the producer-registration flow.
 *
 * Every deadline derives from {@link ProtocolTiming.effectiveEpochSec} (epochs) or from the
 * ROUND envelope (rounds) — never a stopwatch constant. The distinction matters here more than
 * in most flows: a producer's miss is only observable once its slot comes round again, so the
 * demotion phases are budgeted in ROUNDS while the collateral phases are budgeted in EPOCHS.
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
   * Producer NODE processes, and producer ACCOUNTS, in the bootstrap topology.
   *
   * The two are different knobs — `nodeCount` sizes the node processes, `producerCount` the
   * accounts fanned across them — and they are set EQUAL here deliberately. Five genesis
   * producers plus the flow's own gives six schedulable, so the demotion phase can remove one
   * and still leave five: `min_schedule_size` is 4, and at four genesis producers the demotion
   * would land exactly on the floor, where `update_ranked_producers` retains the last good
   * schedule instead of publishing — making the assertion ambiguous rather than failing cleanly.
   */
  export const NodeCount = 5
  /** Producer ACCOUNTS — one per node, so each carries a distinct signing set. */
  export const ProducerCount = 5

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
   * Native RAM granted to the flow's producer before it registers.
   *
   * `roa::newuser` sponsors the account with enough for its own rows, but `regfinkey` bills the
   * `finalizers` + `finkeys` rows to the producer on top of that, and the shortfall surfaces as
   * an opaque "Account using more than allotted RAM usage". On a real chain a producer obtains
   * RAM itself; in the harness this is the equivalent affordance, and the bootstrap grants the
   * genesis producers the same way.
   */
  export const ProducerRamBytes = 1_000_000

  /** Consecutive missed rounds that demote a producer — the `prodscorecfg` default. */
  export const MaxConsecutiveMissedRounds = 3

  /** Blocks one producer holds before the round-robin rotates (`producer_repetitions`). */
  export const BlocksPerProducerRound = 12
  /** Block interval in ms — half-second slots. */
  export const BlockIntervalMs = 500

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
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000

  /** Deadline for depot-side relay effects (balance row, status flip). */
  export function relayDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      RelayEpochBudget *
      MsPerSecond
    )
  }

  /**
   * Wall-clock one full rotation of `scheduleSize` producers takes.
   *
   * Derived, never pinned: a producer's slot comes round once per rotation, so every
   * demotion / recovery budget below is a multiple of this rather than a guessed constant.
   *
   * @param scheduleSize - Producers in the active schedule.
   * @returns One rotation in ms.
   */
  export function rotationMs(scheduleSize: number): number {
    return scheduleSize * BlocksPerProducerRound * BlockIntervalMs
  }

  /**
   * Deadline for a producer to be seen producing a block, or for the schedule to pick it up.
   *
   * @param scheduleSize - Producers in the active schedule.
   * @returns The deadline in ms.
   */
  export function scheduleDeadlineMs(scheduleSize: number): number {
    return rotationMs(scheduleSize) * ScheduleRebuildRoundBudget
  }

  /**
   * Deadline for `max_consecutive_missed_rounds` misses to accrue and the demotion to publish.
   *
   * @param scheduleSize - Producers in the active schedule.
   * @returns The deadline in ms.
   */
  export function demotionDeadlineMs(scheduleSize: number): number {
    return (
      rotationMs(scheduleSize) *
      (MaxConsecutiveMissedRounds + ScheduleRebuildRoundBudget)
    )
  }
}
