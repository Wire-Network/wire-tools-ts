import { SlugName } from "@wireio/sdk-core"
import { WireReserveTool } from "@wireio/test-cluster-tool"

/**
 * Constants for the private-reserve swap flow. Every value carries over from
 * the previously-validated jest run (`tests/constants.ts`): the same-owner
 * PRIVATE reserve pair sizing, the per-phase ~1% swap draws, the 60s-epoch
 * timing budgets, and the private→WIRE exclusion-probe parameters.
 */
export namespace SwapPrivateReservesScenarioConstants {
  /**
   * Timing budgets — 60s epochs per `epoch-stall-is-fatal.md`. Each poll
   * deadline is also the enclosing step's timeout minus
   * {@link Timing.PollDeadlineBufferMs}.
   */
  export namespace Timing {
    /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
    export const EpochDurationSec = 60
    /** Outpost RESERVE_CREATE → depot PENDING row (per chain). */
    export const RelayDeadlineMs = 240_000
    /** RESERVE_READY round-trip → outpost-local record ACTIVE. */
    export const ReadyDeadlineMs = 240_000
    /**
     * SWAP_REQUEST relay + UWREQ insert (also the uwrit.a ACTIVE budget).
     * A request rides the outpost's NEXT outbound emit (0–2 min of phase
     * alignment) + delivery + the depot's createuwreq (~1–1.5 min) — up to
     * ~3.5 minutes end-to-end, so the budget is five epochs.
     */
    export const UwreqDeadlineMs = 300_000
    /** Two-leg underwriter race resolution. */
    export const RaceDeadlineMs = 240_000
    /** SWAP_REMIT delivery + destination payout. */
    export const RemitDeadlineMs = 480_000
    /** Window in which the forbidden private→WIRE UWREQ must NOT appear. */
    export const NoUwreqWindowMs = 90_000
    /** Interval for long-running chain-state polls (ms). */
    export const LongPollIntervalMs = 3_000
    /** Buffer added on top of each poll deadline for the enclosing step timeout (ms). */
    export const PollDeadlineBufferMs = 30_000
  }

  /**
   * The same-owner PRIVATE reserve pair this flow creates via the real gated
   * handshake (outpost create → depot PENDING → matchreserve → ACTIVE), plus
   * the WIRE endpoint identity for the exclusion probe.
   */
  export namespace Reserves {
    /** Shared reserve discriminator for both private reserves. */
    export const PrivateReserveCode = SlugName.from("PRIVATE")

    export namespace Ethereum {
      export const ChainCode = SlugName.from("ETHEREUM")
      /** Native ETH — the pair's native side. */
      export const TokenCode = SlugName.from("ETH")
    }
    export namespace Solana {
      export const ChainCode = SlugName.from("SOLANA")
      /** USDC-on-SOL mock SPL (6 decimals) — the pair's non-native side. */
      export const TokenCode = SlugName.from("USDCSOL")
      /** Native SOL — only used for underwriter bond configuration. */
      export const NativeTokenCode = SlugName.from("SOL")
    }
    export namespace Wire {
      export const ChainCode = SlugName.from("WIRE")
      export const TokenCode = SlugName.from("WIRE")
      /**
       * Non-zero sentinel the outpost requires on a to-WIRE SwapRequest;
       * the depot never quotes or debits a WIRE-side reserve.
       */
      export const SentinelReserveCode = SlugName.from("PRIMARY")
    }
  }

  /**
   * create_reserve parameters for the private pair.
   *
   * Sizing note: a token's depot precision is `min(nativeDecimals, 9)` —
   * each outpost converts at its boundary (`PrecisionLib.toDepot` on ETH
   * downscales 18-dec wei ÷1e9; 6-dec USDCSOL is at the cap or below, so
   * `to_depot` on SOL is identity) before stamping the RESERVE_CREATE
   * attestation's `ReserveAmount`. The ETH escrow lands as 1e10 depot units
   * and the USDCSOL escrow as 1e7 (its native 6-dec base units); each seeds
   * against 1e10 matched WIRE, and the ~1% Phase draws below keep the
   * constant-product math well-conditioned on both books.
   */
  export namespace CreateParams {
    /** ETH escrow — 10 ETH in wei; `toDepot(·, 18)` → 1e10 depot units. */
    export const EthereumEscrowWei = 10_000_000_000_000_000_000n
    /** Depot-frame seed the ETH escrow lands as on the depot row. */
    export const EthereumEscrowDepotUnits = WireReserveTool.toDepot(EthereumEscrowWei, 18)
    /** WIRE (raw 9-dp) the owner matches against the ETH reserve. */
    export const EthereumRequestedWire = 10_000_000_000n
    /** USDCSOL escrow — 10 USDC in 6-dec units; at/below the cap → identity. */
    export const SolanaEscrowChainUnits = 10_000_000n
    /** Depot-frame seed the USDCSOL escrow lands as on the depot row (1e7). */
    export const SolanaEscrowDepotUnits = WireReserveTool.toDepot(SolanaEscrowChainUnits, 6)
    /** WIRE (raw 9-dp) the owner matches against the SOL reserve. */
    export const SolanaRequestedWire = 10_000_000_000n
    /** 50% Bancor connector weight = pure constant product. */
    export const ConnectorWeightBps = 5000
    /** Display metadata forwarded verbatim to the depot rows. */
    export const EthereumName = "ETHEREUM-ETH/WIRE private reserve"
    export const EthereumDescription =
      "flow-swap-private-reserves ETH-side private reserve"
    export const SolanaName = "SOLANA-USDCSOL/WIRE private reserve"
    export const SolanaDescription =
      "flow-swap-private-reserves SOL-side private reserve"
  }

  /**
   * Per-phase swap source amounts. Each phase draws ~1% of its source
   * reserve (Phase A: 1e8 of the 1e10-depot-unit ETH seed; Phase B: 1e5 of
   * the 1e7-unit USDCSOL seed) so slippage stays well inside the tolerance.
   */
  export namespace SwapAmounts {
    /** Phase A: 0.1 ETH in wei; `toDepot(·, 18)` → 1e8 depot units. */
    export const PhaseASourceWei = 100_000_000_000_000_000n
    export const PhaseASourceDepotUnits = WireReserveTool.toDepot(PhaseASourceWei, 18)
    /** Phase B: 0.1 USDCSOL in 6-dec chain units; at/below the cap → identity (1e5). */
    export const PhaseBSourceSplUnits = 100_000n
    export const PhaseBSourceDepotUnits = WireReserveTool.toDepot(PhaseBSourceSplUnits, 6)
    /** USDCSOL chain-native decimals — at/below the cap, so `fromDepot(target, 6)` is identity. */
    export const UsdcSolDecimals = 6
    /** Native-ETH chain decimals — payouts convert `fromDepot(target, 18)` (×1e9). */
    export const EthereumNativeDecimals = 18
  }

  export namespace Variance {
    /** 5% — generous so quote drift between poll and race never reverts. */
    export const ToleranceBps = 500
  }

  /** WIRE accounts provisioned by this flow. */
  export namespace Accounts {
    /** The single WIRE account that matches (and therefore owns) BOTH
     *  private reserves — the pair's same-owner predicate. */
    export const Owner = "privowner"
    /** 2× the two requested WIRE amounts so both matches clear with slack. */
    export const OwnerFunding =
      2n *
      (CreateParams.EthereumRequestedWire + CreateParams.SolanaRequestedWire)
  }

  /** SPL funding for the SOL-side create + Phase B source custody. */
  export namespace SplFunding {
    /** Escrow + Phase B source + generous headroom on the creator's ATA. */
    export const CreatorMintAmount = CreateParams.SolanaEscrowChainUnits * 2n
  }

  /** Parameters for the private→WIRE exclusion probe (final phase). */
  export namespace WireProbe {
    /** 0.01 ETH source deposit (refunded by the SWAP_REVERT). */
    export const SourceEthereumWei = 10_000_000_000_000_000n
    /** Positive sentinel — the privacy gate precedes the variance check. */
    export const TargetAmount = 1n
    export const ToleranceBps = 500
    /** 8-char lowercase WIRE recipient name riding the request as bytes. */
    export const RecipientName = "privrcpt"
  }

  /**
   * Underwriter provisioning: the depot's `createuwreq` re-checks
   * `meets_role_min` for BOTH legs of every swap, and the underwriter
   * plugin's `select_coverable` requires a non-zero credit-line bucket per
   * (chain, token) — so the underwriter must bond on every leg this flow's
   * matrix touches: native ETH, native SOL, and the non-native USDCSOL leg.
   */
  export namespace Underwriting {
    /** Per-(chain, token) `req_uw_collat` minimum bond (raw base units). */
    export const MinimumBond = 1_000_000_000
    /** Collateral bonded per leg by the underwriter (raw base units). */
    export const CollateralAmount = 1_000_000_000n
  }

  /** Mock-SPL-mint manifest the Solana outpost bootstrap persists in the cluster data dir. */
  export const SolanaMockMintsFilename = "sol-mock-mints.json"
}
