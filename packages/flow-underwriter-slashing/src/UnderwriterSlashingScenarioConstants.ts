import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the underwriter-slashing flow (WIRE-297). The swap substrate
 * (chains, amounts, tolerances, timing budgets) mirrors
 * `flow-swap-with-underwriting`'s Phase A exactly — the same ETH→SOL swap,
 * run twice so the flow holds two independently challengeable commitments.
 * Every protocol-wait budget derives from the {@link ProtocolTiming} envelope.
 */
export namespace UnderwriterSlashingScenarioConstants {
  // ── Timing ────────────────────────────────────────────────────────────────

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /** UWREQ row on the depot after the source outpost emits SWAP_REQUEST — a
   *  single outpost→depot hop. */
  export const UwreqDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /** Underwriter race resolution (CONFIRMED): the winning commit lands on the
   *  destination outpost and relays back to the depot — a single hop. */
  export const RaceDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /** Sleep between long-running chain-state polls. */
  export const LongPollIntervalMs = 3_000
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
  /** Hard ceiling on each on-chain write step (submit + confirm). */
  export const RequestStepTimeoutMs = 60_000
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000

  /**
   * Epochs budgeted for the underwriter collateral DEPOSIT_REQUESTs to relay to
   * the depot and flip the underwriter ACTIVE — the same 9-epoch budget the
   * other underwriting flows validated green.
   */
  export const UnderwriterActiveEpochBudget = 9

  /** Deadline for the underwriter deposit relay + ACTIVE eligibility flip —
   *  extension-inclusive epochs so consecutive extended epochs still fit. */
  export function underwriterActiveDeadlineMs(): number {
    return ProtocolTiming.effectiveEpochSec(EpochDurationSec) * UnderwriterActiveEpochBudget * MsPerSecond
  }

  /**
   * Deadline for a challenge resolution to take effect on the depot
   * (verdict + slash + sweep, or verdict + hold-clear — all inline in one
   * `chkuwchal` transaction, so a single-hop budget is generous).
   */
  export const ResolveDeadlineMs = ProtocolTiming.SingleHopBudgetMs

  // ── Registry slugs (must match the bootstrap registry seed) ──────────────

  /** Registered chain slug codes. */
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Registered token slug codes. */
  export const EthereumTokenCode = SlugName.from("ETH")
  export const SolanaTokenCode = SlugName.from("SOL")
  /** The bootstrap-seeded reserve slug both swaps ride. */
  export const PrimaryReserveCode = SlugName.from("PRIMARY")

  /** Ethereum outpost contract the swap user calls `requestSwap` on. */
  export const ReserveManagerContractName = "ReserveManager"

  // ── Reserves & amounts (mirror flow-swap-with-underwriting Phase A) ──────

  /** Wei per depot base unit (native ETH is 18-decimal; the depot frame is 9). */
  export const WeiPerDepotUnit = 10n ** 9n
  /** Each swap's source: 0.1 ETH = 1e17 wei → 1e8 depot units (1% of the seed). */
  export const SourceEthereumWei = 100_000_000_000_000_000n
  /** Variance tolerance attached to each SwapRequest (0.5%). */
  export const ToleranceBps = 50
  /** Per-(chain, token) minimum bond for `req_uw_collat` (see the
   *  swap-with-underwriting constants for the full rationale). */
  export const UnderwriterMinimumBond = 1_000_000_000

  // ── The challenge cast ────────────────────────────────────────────────────

  /**
   * The three Tier-1 voters — the flow-provisioned electorate. With the ONE
   * bootstrap Tier-1 owner (`wireno`) the snapshot is N = 4, Q = ⌊4/2⌋+1 = 3,
   * so all three voting the same way is exactly quorum. The scenario asserts
   * the snapshotted quorum ≤ 3 after each open, so a bootstrap-roster change
   * fails loudly instead of deadlocking the vote.
   */
  export const Tier1VoterNames = ["uwvotera", "uwvoterb", "uwvoterc"] as const

  /** Tier value `roa::forcereg` registers the voters at (Tier-1 electorate). */
  export const Tier1 = 1

  /**
   * The bond-posting challenger. A plain keyed account (shared dev K1 key, so
   * the flow signs its actions), funded from the WIRE treasury below —
   * deliberately NOT a voter: filing and adjudicating stay separate parties.
   */
  export const ChallengerAccount = "uwchallenger"

  /**
   * WIRE the treasury grants the challenger (9-decimal units = 10 WIRE). Each
   * challenge bond is the WIRE value of two ~1e8-unit legs (~0.2 WIRE against
   * the seeded books), so this covers both challenges with margin — and the
   * flow proves every bond comes back (refund or forfeit, never burned).
   */
  export const ChallengerFundingAmount = 10_000_000_000n
  /** The funding transfer's `quantity` string (asset form of the above). */
  export const ChallengerFundingQuantity = "10.000000000 WIRE"
  /** The WIRE treasury account the funding transfer draws from. */
  export const TreasuryAccount = "sysio"

  /** The fault class each challenge alleges (what a real challenger would
   *  claim when the committed source deposit cannot be found). */
  export const ChallengeReason = SysioContracts.SysioChalgUnderwriteFaultReason.SOURCE_DEPOSIT_MISSING
}
