import { SlugName } from "@wireio/sdk-core"

/**
 * Constants for the non-native-token swap flow. Token codes, swap amounts,
 * variance tolerance, and timing budgets carry over from the previously-
 * validated jest run (tests/constants.ts): every swap draws ~1% of the seeded
 * reserves so the two-leg constant-product math stays inside the 200 bps
 * tolerance window, and every poll deadline scales from the 60 s minimum epoch.
 */
export namespace SwapNonNativeScenarioConstants {
  /**
   * Per-leg underwriter bond posted for EVERY (chain, token) the swap matrix
   * touches. The depot's `sysio.uwrit::createuwreq` re-checks `meets_role_min`
   * for BOTH legs of every swap, and the underwriter plugin's
   * `select_coverable` requires the leg's credit line (the depot balance —
   * raw native deposit units — minus persistent locks) to cover the FULL
   * leg amount in the token's depot frame. Sized with heavy margin over the
   * summed live-quoted leg exposures across all five sequential cells (locks
   * persist for the challenge window, so per-leg exposure accumulates).
   */
  export const UnderwriterCollateralAmount = 15_000_000_000n

  /** Native-leg minimum bond mirrored into `sysio.opreg::setconfig req_uw_collat`. */
  export const UnderwriterMinimumBond = 1_000_000_000

  // ── Reserve identity (slug codes) ──────────────────────────────────────

  /** Slug codes for every chain / token / reserve the swap matrix touches. */
  export namespace Reserves {
    /** Every leg pairs against the PRIMARY reserve. */
    export const ReserveCode = SlugName.from("PRIMARY")

    export namespace Ethereum {
      export const ChainCode = SlugName.from("ETHEREUM")
      export const ETH = SlugName.from("ETH")
      export const USDC = SlugName.from("USDC")
      export const USDT = SlugName.from("USDT")
      export const LIQETH = SlugName.from("LIQETH")
    }

    export namespace Solana {
      export const ChainCode = SlugName.from("SOLANA")
      export const SOL = SlugName.from("SOL")
      export const USDCSOL = SlugName.from("USDCSOL")
      export const USDTSOL = SlugName.from("USDTSOL")
      export const LIQSOL = SlugName.from("LIQSOL")
    }
  }

  /** Source amounts per swap cell (source-token NATIVE base units). */
  export namespace SwapAmounts {
    /** ERC-20 stablecoin source draw (6-dec base units — 0.1 USDC / USDT). */
    export const SourceErc20Stable = 100_000n
    /** SPL stablecoin source draw (6-dec base units — 0.1 USDCSOL). */
    export const SourceSplStable = 100_000n
  }

  /**
   * Chain-native decimals per token class — drives the native ↔ depot-frame
   * conversions (`WireReserveTool.toDepot`/`fromDepot`, per-token precision
   * `min(decimals, 9)`) each cell's quote and payout-floor math must mirror.
   */
  export namespace TokenDecimals {
    /** Mock USDC / USDT ERC-20s (`MockUsdc.decimals() == 6`). */
    export const Erc20Stable = 6
    /** Mock USDCSOL / USDTSOL SPL mints (created with 6 decimals). */
    export const SplStable = 6
    /** Native ETH (wei). */
    export const EthereumNative = 18
    /** Native SOL (lamports). */
    export const SolanaNative = 9
  }

  /** Variance-tolerance knobs every SwapRequest publishes. */
  export namespace Variance {
    /** Published tolerance window (bps) — covers cp remainder + swap fee. */
    export const ToleranceBps = 200
  }

  /** Timing budgets (scaled from the 60 s minimum epoch). */
  export namespace Timing {
    export const EpochDurationSec = 60
    /** Per on-chain write step budget. */
    export const WriteTimeoutMs = 60_000
    /**
     * Relay → depot uwreq appearance budget. A request rides the outpost's
     * NEXT outbound emit (0–2 min of phase alignment, verified on-chain
     * 2026-07-03) + delivery + the depot's createuwreq (~1–1.5 min) — up to
     * ~3.5 minutes end-to-end, so a 3-epoch budget was an alignment coin
     * flip. Five epochs covers it with margin.
     */
    export const UwreqDeadlineMs = 300_000
    /** Underwriter race resolution budget (~3 epochs). */
    export const RaceDeadlineMs = 180_000
    /** SWAP_REMIT round-trip + destination payout budget (~8 epochs). */
    export const RemitDeadlineMs = 480_000
    /** Poll cadence for table / balance probes. */
    export const LongPollIntervalMs = 3_000
    /** Slack added to phase timeouts over their poll deadlines. */
    export const PollDeadlineBufferMs = 60_000
  }

  /** The swap user is funded `FundingMultiple ×` each source amount per token. */
  export const FundingMultiple = 100n
  /** Mock ERC-20 units minted to the swap user per stablecoin (10 USDC / 10 USDT). */
  export const Erc20FundingAmount = FundingMultiple * SwapAmounts.SourceErc20Stable
  /** Mock SPL units minted to the swap user per stablecoin (10 USDCSOL / 10 USDTSOL). */
  export const SplFundingAmount = FundingMultiple * SwapAmounts.SourceSplStable

  /** EIP-2612 permit validity window (s) — one hour from signing. */
  export const PermitDeadlineWindowSec = 3_600

  /**
   * Locks the depot pins per settled swap — one per (source, destination) leg.
   * They form in the same transaction that resolves the underwriter race and
   * PERSIST for the wall-clock challenge window (never released by delivery).
   */
  export const LocksPerSwap = 2

  /**
   * Mock-SPL-mint manifest the Solana outpost bootstrapper persists into the
   * cluster data dir (`Array<{ code, mint, decimals }>`).
   */
  export const SolanaMockMintsFilename = "sol-mock-mints.json"

  /**
   * `outpost-addrs.json` keys this flow binds contracts from (the hardhat
   * artifact names match, so these double as ABI artifact names).
   */
  export enum OutpostAddressKey {
    ReserveManager = "ReserveManager",
    MockUsdc = "MockUsdc",
    MockUsdt = "MockUsdt"
  }

  /** `outpost-addrs.json` key per mock ERC-20 token code (ETH-side stablecoins). */
  export const MockErc20AddressKeyByTokenCode: ReadonlyMap<number, OutpostAddressKey> =
    new Map([
      [Reserves.Ethereum.USDC, OutpostAddressKey.MockUsdc],
      [Reserves.Ethereum.USDT, OutpostAddressKey.MockUsdt]
    ])
}
