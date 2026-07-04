import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming, SwapUserIdentities } from "@wireio/test-cluster-tool"

/**
 * Constants for the reserve-lifecycle flow. Amounts and reserve identities
 * carry over from the previously-validated jest run; protocol waits derive
 * from the {@link ProtocolTiming} envelope. A linked creator opens a PRIVATE
 * ETH reserve (PENDING → matched → ACTIVE with exact WIRE custody), an
 * unlinked creator's reserve is cancelled back + refunded, and the private
 * reserve is excluded from public pairings and WIRE-endpoint swaps.
 */
export namespace ReserveLifecycleScenarioConstants {
  // ── timing (60s epochs per `epoch-stall-is-fatal.md`) ──────────────────────

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /**
   * Outpost RESERVE_CREATE → OPP relay → depot `oncrtreserve` row insert — a
   * single outpost→depot hop.
   */
  export const RelayDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /**
   * Depot RESERVE_READY / RESERVE_CREATE_CANCELLED back to the outpost (local
   * record flip + refund both ride inbound dispatch) — a single
   * depot→outpost hop.
   */
  export const ReadyDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /**
   * Window in which a FORBIDDEN UWREQ must NOT appear. ~1.5 epochs — long
   * enough for the SWAP_REQUEST to have relayed and been rejected, short
   * enough to keep the inverted poll cheap.
   */
  export const NoUwreqWindowMs = 90_000
  /** Interval for long-running chain-state polls (ms). */
  export const PollIntervalMs = 3_000
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
  /** Step timeout for single Ethereum-outpost writes (tx submit + 1 confirmation). */
  export const EthereumWriteStepTimeoutMs = 60_000
  /** Step timeout for WIRE depot writes (each waits to irreversibility). */
  export const WireWriteStepTimeoutMs = 120_000

  // ── reserve identities ─────────────────────────────────────────────────────

  /** Registered chain slug codes (must match the bootstrap registry seed). */
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Registered token slug codes. */
  export const EthereumTokenCode = SlugName.from("ETH")
  export const SolanaTokenCode = SlugName.from("SOL")
  /** The gated + PRIVATE reserve — linked creator, real WIRE match. */
  export const PrivateReserveCode = SlugName.from("PRIVRES")
  /**
   * The unlinked-creator reserve — depot cancels it back and the outpost
   * refunds. `NOLINKRS` (not `NOLINKRES`) because slug_names cap at 8 chars.
   */
  export const NoLinkReserveCode = SlugName.from("NOLINKRS")
  /**
   * Bootstrap-seeded public counterpart proving private↔public pairing is
   * rejected — the (f) probe pairs the private reserve against this one, so
   * it must exist for the rejection to be attributable to privacy.
   */
  export const PublicReserveCode = SlugName.from("PRIMARY")

  // ── create_reserve parameters ──────────────────────────────────────────────

  /** 0.05 ETH escrowed into PRIVRES (msg.value — must equal the arg). */
  export const PrivateEscrowWei = 50_000_000_000_000_000n
  /** 0.02 ETH escrowed into NOLINKRS — refunded on the cancel round-trip. */
  export const NoLinkEscrowWei = 20_000_000_000_000_000n
  /**
   * WIRE (raw 9-dp base units) the matcher must escrow — `matchreserve`
   * requires `wire_amount == requested_wire_amount` EXACTLY, so the negative
   * and positive match pushes both pass this verbatim.
   */
  export const RequestedWireAmount = 1_000_000n
  /** 50% Bancor connector weight = pure constant product. */
  export const ConnectorWeightBps = 5000
  /** Display metadata forwarded verbatim to the depot row. */
  export const PrivateReserveName = "ETHEREUM-ETH/WIRE private reserve"
  export const PrivateReserveDescription = "flow-reserve-lifecycle gated+private reserve"
  export const NoLinkReserveName = "ETHEREUM-ETH/WIRE unlinked-creator reserve"
  export const NoLinkReserveDescription = "flow-reserve-lifecycle cancelled-back reserve"

  // ── private↔public swap probe (the depot rejects on privacy, pre-variance) ─

  /** 0.01 ETH source deposit (refunded by the SWAP_REVERT). */
  export const SwapProbeSourceEthereumWei = 10_000_000_000_000_000n
  /** Positive sentinel — never reaches the variance comparison. */
  export const SwapProbeTargetAmount = 1n
  /** 5% — irrelevant to the privacy gate; matches template defaults. */
  export const SwapProbeToleranceBps = 500

  // ── `swapfromwire` private-exclusion probe ─────────────────────────────────

  /** 0.001 WIRE — never escrowed; the push asserts before the transfer. */
  export const FromWireProbeWireAmount = 1_000_000n
  /** Positive sentinel — the privacy assert fires first. */
  export const FromWireProbeTargetAmount = 1n
  export const FromWireProbeToleranceBps = 500

  // ── WIRE accounts provisioned by this flow ─────────────────────────────────

  /** The authex-linked matcher that legitimately activates PRIVRES. */
  export const MatcherAccount = "rsrvmatcher"
  /** Funded the same as the matcher but NEVER authex-linked. */
  export const WrongMatcherAccount = "wrongmatchr"
  /** 1 WIRE — covers the 0.001 WIRE match escrow with generous slack. */
  export const MatcherFunding = 1_000_000_000n
  /** Same funding so only the missing link differentiates the rejection. */
  export const WrongMatcherFunding = 1_000_000_000n

  // ── ETH-side allowances for the unlinked-creator refund assertion ──────────

  /** 0.1 ETH seeded onto the new unlinked wallet from anvil signer 0. */
  export const NoLinkWalletFundingWei = 100_000_000_000_000_000n
  /**
   * 0.005 ETH gas allowance — after the refund lands, the creator's balance
   * must exceed `preCreate - this` (create_reserve gas is the only
   * unrecovered spend).
   */
  export const RefundGasAllowanceWei = 5_000_000_000_000_000n

  /**
   * Anvil HD-derivation index of the unlinked creator wallet — one past the
   * shared swap-user slot so it can never collide with an operator or the
   * linked creator wallet.
   */
  export const NoLinkCreatorHdIndex = SwapUserIdentities.DefaultEthereumHdIndex + 1

  // ── cluster option defaults ────────────────────────────────────────────────

  /** Per-chain underwriter collateral minimum (raw outpost units). */
  export const UnderwriterMinimumBond = 1_000_000_000

  // ── depot assert-message patterns (the negative gates match on these) ──────

  /** `sysio.reserv::matchreserve` rejection for a matcher with no authex link. */
  export const MatcherNotLinkedPattern = /matcher has no authex link/
  /** `sysio.uwrit::swapfromwire` rejection for a private destination reserve. */
  export const PrivateFromWireExcludedPattern = /private reserves are excluded from WIRE-endpoint swaps/

  // ── misc ───────────────────────────────────────────────────────────────────

  /** The `pollUntil` deadline-expiry message fragment (an expiry IS the inverted-poll pass). */
  export const PollTimeoutMessageFragment = "Timed out waiting for"
  /** Outpost contract name for artifact/address resolution. */
  export const ReserveManagerContractName = "ReserveManager"
}
