import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/test-cluster-tool"

/**
 * Constants for the swap-to-WIRE flow — amounts, slug codes, and timing
 * budgets. Protocol waits derive from the {@link ProtocolTiming} envelope. The
 * flow is single-leg: the user escrows native ETH on the source outpost, the
 * depot books the source reserve and pays the recipient REAL WIRE from
 * `sysio.reserv` custody inline — no destination outpost, no SWAP_REMIT.
 */
export namespace SwapToWireScenarioConstants {
  // ── Timing budgets (60s epochs per `epoch-stall-is-fatal.md`) ────────────

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /** SWAP_REQUEST relay + UWREQ insert — a single outpost→depot hop. */
  export const UwreqDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /** Single-leg underwriter race (source commit only) — a single hop. */
  export const RaceDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /**
   * Direct WIRE payout window. The depot pays in the SAME transaction that
   * resolves the race — no outpost hop — so this stays a depot-local window
   * rather than an envelope class.
   */
  export const PayoutDeadlineMs = 120_000
  /** Interval for long-running chain-state polls (ms). */
  export const LongPollIntervalMs = 3_000
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000
  /** Timeout ceiling for the flow's on-chain WRITE steps (ms). */
  export const WriteTimeoutMs = 60_000
  /**
   * Epochs budgeted for the underwriter DEPOSIT_REQUESTs to relay + credit on
   * the depot and flip the underwriters ACTIVE — above the envelope's
   * 4–6 minute collateral class.
   */
  export const RelayEpochBudget = 9
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000

  /** Deadline for the underwriter bonds to credit over OPP and flip ACTIVE —
   *  extension-inclusive epochs so consecutive extended epochs still fit. */
  export function relayDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      RelayEpochBudget *
      MsPerSecond
    )
  }

  // ── Bootstrap-seeded reserve identity (source leg) ───────────────────────

  /** Registered chain slug codes (must match the bootstrap registry seed). */
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Registered token slug codes. */
  export const EthereumTokenCode = SlugName.from("ETH")
  export const SolanaTokenCode = SlugName.from("SOL")
  /** The bootstrap-seeded ETHEREUM/ETH reserve consumed as the source leg. */
  export const EthereumReserveCode = SlugName.from("PRIMARY")

  // ── The WIRE target identity ──────────────────────────────────────────────

  /** The depot chain/token slug codes the swap targets. */
  export const WireChainCode = SlugName.from("WIRE")
  export const WireTokenCode = SlugName.from("WIRE")
  /**
   * The depot pays WIRE directly — there is no WIRE-side reserve — but the
   * outposts require a NON-ZERO targetReserveCode, so the PRIMARY sentinel
   * rides the SwapRequest and is never quoted or debited.
   */
  export const WireSentinelReserveCode = SlugName.from("PRIMARY")

  // ── Swap amounts ─────────────────────────────────────────────────────────

  /**
   * 0.1 ETH = 1e17 wei → 1e8 depot units (18-dec wei is above the per-token
   * depot precision cap of 9, so the ETH outpost divides by 1e9). ~1% of the
   * seeded reserve, so slippage stays well inside the tolerance.
   */
  export const SourceEthereumWei = 100_000_000_000_000_000n
  /** The escrowed source amount in the depot's 9-decimal frame. */
  export const SourceDepotUnits = SourceEthereumWei / 10n ** 9n
  /** 5% — generous so quote drift between poll and race never reverts. */
  export const ToleranceBps = 500

  // ── Accounts ─────────────────────────────────────────────────────────────

  /** Swap-to-WIRE recipient — exists, holds no WIRE until the payout. */
  export const RecipientAccount = "wirercpt"
  /** The depot's reserve-custody account (real WIRE backing every reserve row). */
  export const ReserveCustodyAccount = "sysio.reserv"
  /**
   * Per-(chain, token) collateral minimum gating underwriter ACTIVE status —
   * matches {@link WireUnderwriterTool.DefaultAmount} so the default bond meets
   * the minimum exactly on both outpost chains.
   */
  export const UnderwriterMinimumBond = 1_000_000_000

  // ── Ethereum outpost artifacts ───────────────────────────────────────────

  /** The outpost contract holding reserves + `requestSwap` (deploy-artifact key). */
  export const ReserveManagerContractName = "ReserveManager"

  // ── Table-read limits ────────────────────────────────────────────────────

  /** Row ceiling for the `sysio.opreg::operators` roster read. */
  export const OperatorTableRowLimit = 100
  /**
   * Row ceiling for the `sysio.msgch::attestations` negative scan — generous
   * versus the handful of attestation rows a short flow run accumulates, so a
   * queued SWAP_REMIT cannot hide past the read window.
   */
  export const AttestationScanRowLimit = 500

  /**
   * Hex characters encoding the uwreq id's low byte — `SwapRemit.
   * original_message_id` carries the uwreq id in its low 8 bytes (LE), so the
   * id's low byte leads the attestation's hex-encoded data payload.
   */
  export const UwreqIdHexByteWidth = 2
}
