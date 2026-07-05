import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the swap-from-WIRE flow. Protocol waits derive from the
 * {@link ProtocolTiming} envelope; reserve slug codes, the escrow amount, and
 * the depositor account carry over from the previously-validated suite: the
 * depositor escrows 0.1 WIRE against the bootstrap-seeded SOLANA/SOL/PRIMARY
 * reserve and the payout lands on a provisioned Solana recipient.
 */
export namespace SwapFromWireScenarioConstants {
  /** Swap-from-WIRE depositor — a plain WIRE user funded from the treasury. */
  export const DepositorAccount = "wirefromusr"
  /** Treasury funding (raw 9-dec WIRE): 10× the escrow so re-runs in one cluster still work. */
  export const DepositorFunding = 1_000_000_000n

  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /** Epochs budgeted for the depot-internal `drainfwq` queue drain. */
  export const DrainEpochBudget = 3
  /** 1 s in ms — multiplies epoch counts into ms deadlines. */
  export const MsPerSecond = 1_000

  /**
   * `swapfromwire` is QUEUED — the PENDING uwreq materialises at the next
   * `sysio.epoch::advance` (drainfwq). Depot-internal, so the budget is
   * extension-inclusive epochs rather than a hop class. Also bounds the #425
   * rewards-bucket custody settlement poll.
   */
  export const DrainDeadlineMs =
    ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
    DrainEpochBudget *
    MsPerSecond
  /** Single-leg underwriter race (target commit only) — a single hop: the
   *  winning commit lands on the SOL outpost and relays back to the depot. */
  export const RaceDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /** SWAP_REMIT delivery to the SOL outpost + recipient credit — the tail of
   *  the depot→outpost path, budgeted as the double hop. */
  export const RemitDeadlineMs = ProtocolTiming.DoubleHopBudgetMs
  /** Interval for long-running chain-state polls (ms). */
  export const PollIntervalMs = 3_000
  /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
  export const PollDeadlineBufferMs = 30_000

  /** Epochs budgeted for the underwriter bonds to relay + credit + flip ACTIVE —
   *  above the envelope's 4–6 minute collateral class. */
  export const RelayEpochBudget = 9

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
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      RelayEpochBudget *
      MsPerSecond
    )
  }
}
