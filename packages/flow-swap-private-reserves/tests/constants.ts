import { SlugName } from "@wireio/sdk-core"

/**
 * Timing budgets — 60s epochs per `epoch-stall-is-fatal.md`. The
 * bootstrap window is doubled vs. the single-leg flows because the
 * beforeAll drives TWO full gated create→match handshakes (one per
 * outpost) on top of the cluster bootstrap.
 */
export namespace Timing {
  export const EpochDurationSec   = 60
  export const BootstrapTimeoutMs = 720_000
  /** Outpost RESERVE_CREATE → depot PENDING row (per chain). */
  export const RelayDeadlineMs    = 240_000
  /** RESERVE_READY round-trip → outpost-local record ACTIVE. */
  export const ReadyDeadlineMs    = 240_000
  /** SWAP_REQUEST relay + UWREQ insert. */
  export const UwreqDeadlineMs    = 180_000
  /** Two-leg underwriter race resolution. */
  export const RaceDeadlineMs     = 240_000
  /** SWAP_REMIT delivery + destination payout. */
  export const RemitDeadlineMs    = 480_000
  /** Window in which the forbidden private→WIRE UWREQ must NOT appear. */
  export const NoUwreqWindowMs    = 90_000
  export const LongPollIntervalMs = 3_000
}

/**
 * The same-owner PRIVATE reserve pair this flow creates via the real
 * gated handshake (outpost create → depot PENDING → matchreserve →
 * ACTIVE), plus the WIRE endpoint identity for the exclusion probe.
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
 * Sizing note: the outposts convert the escrow to the depot's 9-decimal
 * frame at the boundary (`PrecisionLib.toDepot` on ETH, `precision::
 * to_depot` on SOL) and ship it inside the RESERVE_CREATE attestation's
 * `ReserveAmount` — exactly like the swap paths. Both escrows below are
 * wallet-scale chain-native amounts that land as 1e10 depot units, so
 * the depot rows seed ~1:1 against the matched WIRE and the constant-
 * product math over a 1e8 depot-unit draw (~1%) stays well-conditioned.
 */
export namespace CreateParams {
  /** ETH escrow — 10 ETH in wei; `toDepot(·, 18)` → 1e10 depot units. */
  export const EthereumEscrowWei      = 10_000_000_000_000_000_000n
  /** Depot-frame seed the ETH escrow lands as on the depot row. */
  export const EthereumEscrowDepotUnits = EthereumEscrowWei / 10n ** 9n
  /** WIRE (raw 9-dp) the owner matches against the ETH reserve. */
  export const EthereumRequestedWire  = 10_000_000_000n
  /** USDCSOL escrow — 10 USDC in 6-dec units; `to_depot(·, 6)` → 1e10. */
  export const SolanaEscrowChainUnits = 10_000_000n
  /** Depot-frame seed the USDCSOL escrow lands as on the depot row. */
  export const SolanaEscrowDepotUnits = SolanaEscrowChainUnits * 1_000n
  /** WIRE (raw 9-dp) the owner matches against the SOL reserve. */
  export const SolanaRequestedWire    = 10_000_000_000n
  /** 50% Bancor connector weight = pure constant product. */
  export const ConnectorWeightBps     = 5000
  /** Display metadata forwarded verbatim to the depot rows. */
  export const EthereumName           = "ETHEREUM-ETH/WIRE private reserve"
  export const EthereumDescription    = "flow-swap-private-reserves ETH-side private reserve"
  export const SolanaName             = "SOLANA-USDCSOL/WIRE private reserve"
  export const SolanaDescription      = "flow-swap-private-reserves SOL-side private reserve"
}

/**
 * Per-phase swap source amounts. Both phases draw 1e8 depot units (~1%
 * of the 1e10 seeds) so slippage stays well inside the tolerance.
 */
export namespace SwapAmounts {
  /** Phase A: 0.1 ETH in wei (the ETH outpost divides by 1e9 → depot). */
  export const PhaseASourceWei        = 100_000_000_000_000_000n
  export const PhaseASourceDepotUnits = PhaseASourceWei / 10n ** 9n
  /**
   * Phase B: 0.1 USDCSOL in 6-dec chain units. Under per-token precision
   * USDCSOL is carried at its native 6 decimals in the depot frame
   * (min(6, 9) = 6), so the outpost's to_depot is identity — the depot units
   * equal the chain units.
   */
  export const PhaseBSourceSplUnits   = 100_000n
  export const PhaseBSourceDepotUnits = PhaseBSourceSplUnits
  /**
   * USDCSOL depot precision == native (6), so `from_depot(amount, 6)` is the
   * identity — no scaling between depot units and SPL base units.
   */
  export const UsdcSolFromDepotDivisor = 1n
  /** Depot 9-dec → wei scale for native-ETH payouts (ETH stays 9-dec depot-side). */
  export const EthWeiPerDepotUnit      = 1_000_000_000n
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
    2n * (CreateParams.EthereumRequestedWire + CreateParams.SolanaRequestedWire)
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
  export const TargetAmount      = 1n
  export const ToleranceBps      = 500
  /** 8-char lowercase WIRE recipient name riding the request as bytes. */
  export const RecipientName     = "privrcpt"
}

/**
 * Local mirror of `ReserveManager.sol::LocalReserveStatus` (zero-indexed
 * one-byte storage enum: PENDING=0, ACTIVE=1, CANCELLED=2). Distinct from
 * the depot's proto `ReserveStatus` (UNKNOWN=0, PENDING=1, ACTIVE=2,
 * CANCELLED=3) — the translation happens at the outpost dispatch boundary.
 */
export enum EthLocalReserveStatus {
  PENDING = 0,
  ACTIVE = 1,
  CANCELLED = 2
}
