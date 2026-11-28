import { SysioContracts } from "@wireio/sdk-core"

import { OutpostChainCodenames } from "@wireio/cluster-tool-shared"
import { Constants, outputKey, ProtocolTiming, producerName } from "@wireio/cluster-tool"

/**
 * Constants for the economic-clock flow. The cluster runs every outpost chain's consensus epoch at
 * 60 s and the economic clock at twice that, so the two clocks tick on visibly different grids while
 * every phase stays a few economic epochs long. Every wait derives from the two durations through
 * `ProtocolTiming`.
 */
export namespace EconomicClockScenarioConstants {
  /** Consensus epoch duration (s) of every outpost chain. */
  export const EpochDurationSec = 60

  /**
   * Economic epoch duration (s): twice the consensus epoch. The shortest whole multiple of the
   * consensus epoch that is longer than it, so consensus advances about twice per economic epoch
   * and a withdrawal's two-epoch economic wait (240 s) outlasts its two-epoch consensus guard
   * (120 s) by a full economic epoch. Raising it lengthens every phase by the same factor.
   */
  export const EconomicEpochDurationSec = 120

  /** Producers in the bootstrap roster: one, the producer whose pay the flow claims. */
  export const ProducerCount = 1

  /** The producer whose epoch pay the flow claims — the genesis producer's account. */
  export const Producer = producerName(0)

  /**
   * Economic epochs the clock-independence phase observes. Its window spans the seven economic
   * epochs between the first and the last, 840 s, in which the consensus envelope (a kept-due
   * consensus epoch closes within 90 s, `ProtocolTiming.EpochExtensionMaxSec`) guarantees at least
   * nine consensus advances even with 30 s of crank lag between the two readings — more than the
   * seven economic epochs, so "consensus advances more often" follows from the envelope, not
   * from a fast run. Sized for slack: a kept-due cycle really runs ≤ 73 s (60 s, plus ≤ 10 s of
   * keep-due pump latency, ≤ 2.5 s of relay `chkcons` poll and a block), so a chain closes at
   * least `floor(810 / 73)` = 11 — 2 epochs above the bound (`810 × (1/73 − 1/90)` ≈ 2.1), where
   * the earlier five epochs (480 s) left ≈ 1.3. Fewer than eight leaves under 2 epochs of slack.
   */
  export const ClockObservationEpochs = 8

  /** Economic epochs each later await observes: the next one to open. */
  export const NextEconomicEpoch = 1

  /** The pay period `sysio::emitcfg` must carry: one economic epoch, so every epoch is a pay epoch. */
  export const PayCadenceEpochs = 1

  /**
   * `sysio.opreg::WITHDRAW_WAIT_ECONOMIC_EPOCHS` — economic epochs between a withdrawal request
   * and its release.
   */
  export const WithdrawWaitEconomicEpochs = 2

  /**
   * Epochs a withdrawal wait spends in the epoch its request fell in, which the wait does not
   * count: its await allows them on top of the wait itself.
   */
  export const RequestEpochs = 1

  /**
   * Economic boundaries that may pass unopened between a tick and a reading taken right after a
   * request: one, since the crank opens an economic epoch within seconds of its boundary, so a
   * request may fall in the epoch after the last one ticked.
   */
  export const UntickedEconomicBoundaries = 1

  /**
   * The flow's NON-bootstrapped batch operator (its durable label, also its account). It bonds
   * WIRE but no collateral minimum is configured, so it stays `OPERATOR_STATUS_UNKNOWN`: the
   * schedule never seats it, so it needs no relay daemon, and `withdraw` still accepts it.
   */
  export const WithdrawerLabel = "withdrawer"

  /**
   * The outpost chains the withdrawer serves: every one, so each request waits on every chain's
   * consensus guard. Joining needs no ACTIVE status, and an UNKNOWN operator is never seated.
   */
  export const WithdrawerServedChains = OutpostChainCodenames

  /**
   * The outpost chain governance pauses on a decided epoch for the second withdrawal: its decided
   * epoch passes the request's wait on it while its index stands still, and the other chain keeps
   * advancing.
   */
  export const PausedChain = Constants.ETHEREUM_CHAIN_CODENAME

  /**
   * Epochs of {@link PausedChain} the decided-and-idle await allows: the one in progress (its
   * decision lands one round trip after it opened), an advance its traffic may still bring, and one
   * of margin.
   */
  export const DecidedEpochAwaitEpochs = 3

  /** WIRE the withdrawer bonds — 2 WIRE. */
  export const BondAmount = 2_000_000_000n

  /** WIRE each of the two withdrawal requests takes — 0.5 WIRE. */
  export const WithdrawAmount = 500_000_000n

  /** The withdrawer's claim once both requests have matured. */
  export const MaturedClaimAmount = WithdrawAmount * 2n

  /**
   * The account that holds `sysio`'s spendable WIRE while emissions are held, created under the
   * dev key so the flow signs the refund.
   */
  export const TreasuryHolder = "econ.holder"

  /** Memo on the transfer that drains `sysio`'s spendable WIRE. */
  export const DrainMemo = "flow-economic-clock: hold emissions"

  /** Memo on the transfer that refunds it. */
  export const RefundMemo = "flow-economic-clock: release emissions"

  /** `sysio.andon::pull` reason. */
  export const AndonReason = "flow-economic-clock: emissions under the cord"

  /** `sysio.andon::clear` note. */
  export const AndonNote = "flow-economic-clock: cord cleared"

  /**
   * The two outposts whose envelope round trip the held-emissions phase waits for, as
   * `sysio.msgch::envlog` endpoints spell them.
   */
  export const OutpostChainKinds = [
    SysioContracts.SysioMsgchChainkind.CHAIN_KIND_EVM,
    SysioContracts.SysioMsgchChainkind.CHAIN_KIND_SVM
  ] as const

  // ── Observation, snapshot and record names ────────────────────────────────

  /** The clock-independence observation. */
  export const ClockObservation = "clock-independence"
  /** The reading before the withdrawal whose consensus guard passes first. */
  export const ConsensusFirstObservation = "consensus-first-request"
  /** The reading before the withdrawal made while {@link PausedChain} is paused on a decided epoch. */
  export const PausedDecidedObservation = "paused-decided-request"
  /** The epoch the treasury drain lands in. */
  export const DrainObservation = "treasury-drain"
  /** An economic epoch that opens while emissions are held. */
  export const HeldObservation = "emissions-held"
  /** An economic epoch that opens while the andon cord is pulled. */
  export const CordObservation = "andon-cord"

  /** The withdrawal whose consensus guard passes first. */
  export const ConsensusFirstWithdrawal = "consensus-first"
  /** The withdrawal made while {@link PausedChain} is paused on a decided epoch. */
  export const PausedDecidedWithdrawal = "paused-decided"

  /** The producer pay claimed after the clock-independence phase. */
  export const ClockPayClaim = "clock-independence"
  /** The producer pay claimed under the andon cord. */
  export const CordPayClaim = "andon-cord"

  /** The emissions hold. */
  export const Hold = "balance-insufficient"
  /** The release of that hold. */
  export const Release = "refunded"

  /** `sysio`'s spendable WIRE the drain moved to {@link TreasuryHolder}; the refund returns it. */
  export const DrainedWire = outputKey<bigint>(
    "economicClock.drainedWire",
    "sysio's spendable WIRE moved to the treasury holder while emissions are held"
  )

  // ── Step options ──────────────────────────────────────────────────────────

  /**
   * Economic epochs the hold and release awaits allow: the epoch the triggering write lands in,
   * and the next, whose tick holds or pays.
   */
  export const HoldEpochBudget = 2

  /**
   * The envelope round trip during the hold: one depot envelope out to each outpost and that
   * outpost's answering envelope back — a single-hop class wait on each leg's consensus.
   */
  export const RoundTripOptions = {
    timeoutMs:
      ProtocolTiming.SingleHopBudgetMs + ProtocolTiming.PollDeadlineBufferMs
  }
}
