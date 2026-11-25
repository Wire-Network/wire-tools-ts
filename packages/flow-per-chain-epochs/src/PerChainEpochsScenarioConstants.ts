import {
  OutpostChainCodename,
  type OutpostEpochDurations
} from "@wireio/cluster-tool-shared"

/**
 * Constants for the per-chain-epochs flow. Ethereum runs its consensus epoch at 60 s and Solana
 * at 150 s — two durations neither of which divides the other, so a seat-second total tells the
 * chain it was earned on, and long enough apart that the faster chain's advance count over the
 * observed window provably exceeds the slower one's. Every wait derives from the chain it waits
 * on through `ProtocolTiming`.
 */
export namespace PerChainEpochsScenarioConstants {
  /**
   * Ethereum's consensus epoch duration (s). Changing it moves every Ethereum wait with it, and it
   * must stay distinct from {@link SolanaEpochDurationSec} and neither a divisor nor a multiple of
   * it, or the seat-second checks can no longer tell the chains apart; {@link CadenceWindowSec}
   * must still separate the two chains' advance counts.
   */
  export const EthereumEpochDurationSec = 60

  /**
   * Solana's consensus epoch duration (s): 2.5 × Ethereum's. Not a multiple of Ethereum's, so a
   * seat-second total that is a multiple of one chain's duration is not, for small seat counts, a
   * multiple of the other's; and slow enough that {@link CadenceWindowSec} separates the two
   * chains' advance counts. Raising it lengthens every Solana wait by the same factor.
   */
  export const SolanaEpochDurationSec = 150

  /** Each outpost chain's consensus epoch duration — the scenario's `outpostEpochDurationSec`. */
  export const OutpostEpochDurationSec: OutpostEpochDurations = {
    [OutpostChainCodename.ETHEREUM]: EthereumEpochDurationSec,
    [OutpostChainCodename.SOLANA]: SolanaEpochDurationSec
  }

  /**
   * Economic epoch duration (s): twice Ethereum's epoch. A withdrawal waits two economic epochs,
   * and an open pay period's `batchduty` rows live about one economic epoch, long enough for a
   * poll to read them before settlement erases them.
   */
  export const EconomicEpochDurationSec = 120

  /**
   * Bootstrapped batch operators: 9 → 3 groups of 3 on each chain. A group keeps its majority
   * when the flow's operator misses a delivery, so no chain stalls on it.
   */
  export const BatchOperatorCount = 9

  /** Ad-hoc node port pairs to reserve: one, the serving operator's relay daemon. */
  export const AdHocDaemonCount = 1

  /** `requiredBatchOperatorCollateral` `(WIRE, WIRE)` minimum — 1 WIRE. */
  export const MinimumBond = 1_000_000_000n

  // ── The serving operator ──────────────────────────────────────────────────

  /**
   * The flow's NON-bootstrapped batch operator that serves Ethereum alone, then joins Solana and
   * leaves Ethereum (its durable label, also its account). Non-bootstrapped operators are seated
   * first, so each chain it serves seats it.
   */
  export const ServingOperatorLabel = "chainop"

  /** WIRE the serving operator bonds — 2 WIRE, above {@link MinimumBond}, so it turns ACTIVE. */
  export const ServingBond = 2_000_000_000n

  // ── The Solana-only withdrawer ────────────────────────────────────────────

  /**
   * The flow's NON-bootstrapped batch operator that serves Solana alone (its label, also its
   * account). It bonds below {@link MinimumBond}, so it stays `OPERATOR_STATUS_UNKNOWN`: no
   * schedule seats it and it needs no relay, yet its Solana membership is the one chain its
   * withdrawal waits on.
   */
  export const WithdrawerLabel = "solwithdraw"

  /** WIRE the withdrawer bonds — 0.5 WIRE, below the minimum. */
  export const WithdrawerBond = 500_000_000n

  /** WIRE the withdrawer withdraws — 0.25 WIRE. */
  export const WithdrawAmount = 250_000_000n

  // ── Windows and budgets (counts of epochs of the chain waited on) ─────────

  /**
   * The cadence observation window (s). Over W seconds a chain of duration d closes at least
   * `floor(W / (d + 30))` epochs and at most `floor(W / d) + 2` (its epochs start on a fixed grid,
   * and it can trail its boundary by one epoch at the window's start). At 720 s Ethereum closes
   * at least 8 and Solana at most 6, so the faster chain's count exceeds the slower one's on any
   * run.
   */
  export const CadenceWindowSec = 720

  /**
   * Epochs of a chain budgeted for a newly ACTIVE (or newly joined) operator to ride into a
   * schedule-window tail group of it: at most one advance per group after it became eligible,
   * and non-bootstrapped operators are picked first.
   */
  export const ScheduleWindowEpochs = 5

  /**
   * Extra epochs, on top of the chain's group count, a rotation wait allows: a full rotation pops
   * every resident group once, and one more epoch covers the advance that lands the last seat.
   */
  export const RotationMarginEpochs = 1

  /** Economic epochs a duty wait allows on top of the chain's rotation: the open period's close. */
  export const DutyPeriodEconomicEpochs = 1

  /**
   * Epochs of a chain a duty wait allows after a seat's own epoch closes: the advance after it closes that
   * epoch's books and credits the seat's seat-seconds. Changing it moves every seat-seconds deadline.
   */
  export const BookClosingEpochs = 1

  /** Ethereum epochs the resumed chain must advance after the unpause. */
  export const ResumeEpochs = 1

  /** Ethereum epochs budgeted for that advance: a resumed chain may need one catch-up round. */
  export const ResumeBudgetEpochs = 3

  /** Interval for chain-state polls (ms). */
  export const PollIntervalMs = 2_000

  /** Row ceiling of the `sysio.system::batchduty` read; a truncated read is refused. */
  export const DutyRowLimit = 200

  // ── Observation, snapshot and record names ────────────────────────────────

  /** The clock reading the cadence window starts from. */
  export const CadenceStartObservation = "cadence-start"
  /** The clock reading the cadence window ends at. */
  export const CadenceEndObservation = "cadence-end"
  /** Every chain's epoch index, taken as the serving operator leaves Ethereum. */
  export const LeaveSnapshot = "leave-ethereum"
  /** Every chain's epoch index, taken right before the withdrawal request. */
  export const WithdrawalSnapshot = "withdrawal-request"
  /** The open duty period once the serving operator serves Solana alone. */
  export const SolanaOnlyDutyPeriod = "solana-only"
  /** Both clocks once Ethereum is paused, before the withdrawal. */
  export const PausedStartObservation = "ethereum-paused-start"
  /** Both clocks once the withdrawal has matured, Ethereum still paused. */
  export const PausedEndObservation = "ethereum-paused-end"
}
