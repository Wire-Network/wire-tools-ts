import { SlugName } from "@wireio/sdk-core"

/**
 * Constants for the swap-from-WIRE flow. Timing budgets, reserve slug codes,
 * the escrow amount, and the depositor account carry over from the
 * previously-validated jest suite (`tests/constants.ts`, 2026-06): the depositor
 * escrows 0.1 WIRE against the bootstrap-seeded SOLANA/SOL/PRIMARY reserve and
 * the payout lands on a provisioned Solana recipient.
 */
export namespace SwapFromWireScenarioConstants {
  /** Swap-from-WIRE depositor — a plain WIRE user funded from the treasury. */
  export const DepositorAccount = "wirefromusr"
  /** Treasury funding (raw 9-dec WIRE): 10× the escrow so re-runs in one cluster still work. */
  export const DepositorFunding = 1_000_000_000n

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60

  /**
   * `swapfromwire` is QUEUED — the PENDING uwreq materialises at the next
   * `sysio.epoch::advance` (drainfwq). Budget two epochs + relay slack. Also
   * bounds the #425 rewards-bucket custody settlement poll.
   */
  export const DrainDeadlineMs = 180_000
  /** Single-leg underwriter race (target commit only). */
  export const RaceDeadlineMs = 240_000
  /** SWAP_REMIT delivery to the SOL outpost + recipient credit. */
  export const RemitDeadlineMs = 480_000
  /** Interval for long-running chain-state polls (ms). */
  export const PollIntervalMs = 3_000
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000

  /** Epochs budgeted for the underwriter bonds to relay + credit + flip ACTIVE. */
  export const RelayEpochBudget = 9
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000

  /** Registered chain slug codes (must match the bootstrap registry seed). */
  export const WireChainCode = SlugName.from("WIRE")
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Registered token slug codes. */
  export const WireTokenCode = SlugName.from("WIRE")
  export const EthereumTokenCode = SlugName.from("ETH")
  export const SolanaTokenCode = SlugName.from("SOL")
  /** The bootstrap-seeded reserve's own slug code. */
  export const PrimaryReserveCode = SlugName.from("PRIMARY")

  /**
   * 0.1 WIRE = 1e8 base units escrowed by the depositor — ~1% of the seeded SOL
   * reserve, comfortably inside variance tolerance. WIRE and SOL (lamports)
   * share the 9-decimal frame, so no precision scaling.
   */
  export const SourceWireUnits = 100_000_000n
  /** Variance tolerance carried on the swap request (bps). */
  export const VarianceToleranceBps = 500

  /**
   * Per-(chain, token) `req_uw_collat` minimum gating `OPERATOR_STATUS_ACTIVE` —
   * equals {@link WireUnderwriterTool.DefaultAmount} so the default deposit plan
   * satisfies it exactly on both outposts.
   */
  export const UnderwriterMinimumBond = 1_000_000_000n

  /** Depot-origin id space: bit 63 tags uwreqs queued by `swapfromwire`. */
  export const DepotOriginIdBit = 1n << 63n

  /** Deadline for the underwriter deposit → depot credit → ACTIVE relay. */
  export function relayDeadlineMs(): number {
    return EpochDurationSec * RelayEpochBudget * MsPerSecond
  }
}
