import {
  OutpostChainCodename,
  type OutpostEpochDurations
} from "@wireio/cluster-tool-shared"

/**
 * Constants for the depot-paced-epochs flow. Ethereum runs at its mainnet minimum of 60 s and
 * Solana at 30 s, each with the default traffic wait and late-delivery window (half its minimum),
 * nine bootstrapped batch operators in three groups of three (a strict majority of a group's seats
 * is two) and the economic clock at 120 s. Every wait derives from the chain it waits on through
 * `ProtocolTiming`.
 */
export namespace DepotPacedEpochsScenarioConstants {
  /** Ethereum's consensus epoch minimum (s): its mainnet value. Every Ethereum wait scales with it. */
  export const EthereumEpochDurationSec = 60

  /** Solana's consensus epoch minimum (s): its mainnet value. Every Solana wait scales with it. */
  export const SolanaEpochDurationSec = 30

  /** Each outpost chain's consensus epoch minimum — the scenario's `outpostEpochDurationSec`. */
  export const OutpostEpochDurationSec: OutpostEpochDurations = {
    [OutpostChainCodename.ETHEREUM]: EthereumEpochDurationSec,
    [OutpostChainCodename.SOLANA]: SolanaEpochDurationSec
  }

  /**
   * Economic epoch duration (s). The idle window counts economic epochs, so a longer one stretches
   * that window ({@link IdleWindowMinimums} sets its floor).
   */
  export const EconomicEpochDurationSec = 120

  /** Bootstrapped batch operators: 9, so each chain's window holds three groups of three. */
  export const BatchOperatorCount = 9

  // ── Idle ──────────────────────────────────────────────────────────────────

  /**
   * The idle window spans at least this many of the longest chain minimum: long enough that every
   * chain would have advanced several times on a fixed grid. Raising it adds economic epochs to
   * the window.
   */
  export const IdleWindowMinimums = 3

  /** The economic-clock observation that spans the idle window. */
  export const IdleWindowObservation = "idle-window"

  /** The OPP stream snapshot taken as the idle window opens. */
  export const IdleStartStreams = "idle-start"

  /** The OPP stream snapshot taken as the idle window closes. */
  export const IdleEndStreams = "idle-end"

  /**
   * Row ceiling of the `sysio.msgch::outenvelopes` read. `buildenv` keeps an outpost's envelope
   * only until the outpost consumed it, so the table holds a few rows per chain; a truncated read
   * is refused.
   */
  export const OutboundEnvelopeRowLimit = 100

  // ── Traffic: an Ethereum burst, then a Solana desyndication ─────────────────

  /** Durable handle of the Ethereum holder's persisted wallet. */
  export const HolderWalletName = "depot-paced-holder"

  /** Syndications in the Ethereum burst: each lands before Ethereum is due, so all share one epoch. */
  export const SyndicationCount = 3

  /** liqETH wei each syndication custodies: 0.01 liqETH, above the outpost's 0.005 minimum. */
  export const SyndicationAmountWei = 10_000_000_000_000_000n

  /**
   * ETH the holder deposits beyond the burst: one more syndication's worth. The deposit mints
   * liqETH at the liqETH rate, a little under one per ETH once the token has accrued, so a deposit of
   * exactly the burst leaves the last syndication short.
   */
  export const DepositHeadroomWei = SyndicationAmountWei

  /** Gas headroom the holder's wallet carries beyond its deposit: one ether. */
  export const HolderGasWei = 1_000_000_000_000_000_000n

  /** The WIRE account that receives the mock LIQSOL import and desyndicates part of it to Solana. */
  export const RedeemerAccount = "paced.redeem"

  /** LIQSOL base units the redeemer desyndicates: 1 LIQSOL, above the pair's 0.05 minimum. */
  export const DesyndicationAmount = 1_000_000_000n

  /** Every chain's epoch index, taken before the Ethereum burst. */
  export const BeforeEthereumTraffic = "before-ethereum-traffic"

  /** Every chain's epoch index, taken before the Solana desyndication. */
  export const BeforeSolanaTraffic = "before-solana-traffic"

  /**
   * Epochs of a chain the traffic is allowed to take to be recorded: the relays' backlog read
   * (a quarter of the minimum apart, at the outpost's read confirmation) or the depot's own queue.
   */
  export const DueBudgetEpochs = 1

  /** Epochs of a chain an advance is allowed from the moment its traffic is recorded. */
  export const AdvanceBudgetEpochs = 2

  /**
   * The relay's chkcons polls per chain minimum — wire-sysio's `polls_per_epoch`. With
   * {@link RelayMinimumPollMs} it gives the poll that pushes a due chain's `chkcons`.
   */
  export const RelayPollsPerMinimum = 24

  /** The relay's shortest poll (ms) — wire-sysio's `min_poll_interval`. */
  export const RelayMinimumPollMs = 1_000

  /** The relay's epoch tick step (ms): a due push waits for the next tick after its poll. */
  export const RelayTickStepMs = 1_000

  /** Blocks a pushed `chkcons` may take to land and open the next epoch. */
  export const AdvanceLandingBlocks = 2

  // ── Majority and a late delivery ──────────────────────────────────────────

  /**
   * Epochs of Ethereum allowed for the late member's group to come next on duty: at most one
   * advance per resident group.
   */
  export const NextOnDutyBudgetEpochs = 4

  /** Epochs of Ethereum allowed for the stopped member's epoch to open and be decided. */
  export const MajorityBudgetEpochs = 2

  /** Epochs of Ethereum allowed for the epoch after it to open. */
  export const NextEpochBudgetEpochs = 2

  /** Epochs of Ethereum allowed for the late delivery to land (it must land inside the late window). */
  export const LateDeliveryBudgetEpochs = 1

  /** Epochs of Ethereum allowed for the stopped member's epoch's books to close once its late window passes. */
  export const BooksClosingBudgetEpochs = 2

  /** Interval for chain-state polls (ms): a second, so the restart lands early in the late window. */
  export const PollIntervalMs = 1_000
}
