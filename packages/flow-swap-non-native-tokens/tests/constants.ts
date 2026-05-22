import { SlugName } from "@wireio/sdk-core"

/**
 * Timing budgets for the non-native swap E2E. Scaled from
 * `epoch-stall-is-fatal.md`'s 60s minimum-epoch rule.
 */
export namespace Timing {
  export const EpochDurationSec   = 60
  export const BootstrapTimeoutMs = 360_000
  export const UwreqDeadlineMs    = 180_000
  export const RaceDeadlineMs     = 240_000
  export const RemitDeadlineMs    = 480_000
  export const LongPollIntervalMs = 3_000
}

/**
 * Bootstrap-seeded reserves on the depot. The harness's
 * `ClusterManager.ts::Phase 16c` seeds 10 reserves total:
 *  - ETHEREUM/ETH/PRIMARY, ETHEREUM/LIQETH/PRIMARY,
 *    ETHEREUM/USDC/PRIMARY, ETHEREUM/USDT/PRIMARY
 *  - SOLANA/SOL/PRIMARY, SOLANA/LIQSOL/PRIMARY,
 *    SOLANA/USDCSOL/PRIMARY, SOLANA/USDTSOL/PRIMARY
 *
 * `USDCSOL`/`USDTSOL` are the depot-side codes for USDC/USDT on the
 * SOL side (per the v6 "TWO Token rows per cross-chain pair"
 * decision — same underlying asset but distinct depot-side rows so
 * the `code` primary key doesn't collide).
 */
export namespace Reserves {
  export const InitialAmount = 10_000_000_000n
  export const ReserveCode   = SlugName.from("PRIMARY")

  export namespace Ethereum {
    export const ChainCode = SlugName.from("ETHEREUM")
    export const ETH       = SlugName.from("ETH")
    export const LIQETH    = SlugName.from("LIQETH")
    export const USDC      = SlugName.from("USDC")
    export const USDT      = SlugName.from("USDT")
  }
  export namespace Solana {
    export const ChainCode = SlugName.from("SOLANA")
    export const SOL       = SlugName.from("SOL")
    export const LIQSOL    = SlugName.from("LIQSOL")
    export const USDCSOL   = SlugName.from("USDCSOL")
    export const USDTSOL   = SlugName.from("USDTSOL")
  }
}

/**
 * Per-token source amounts for swap legs. Sized in chain-native base
 * units (the outpost converts to/from the depot's uniform 9-decimal
 * frame via `PrecisionLib` on every transfer).
 *
 *  - **ETH side**: 18-decimal native ETH, 18-decimal LIQETH, 6-decimal
 *    USDC/USDT. The outpost's `_toDepotUnits(code, amount)` scales
 *    each correctly. `0.1 ETH = 1e17 wei = 1e8 depot units` (1% of
 *    reserve seed). `1 USDC = 1e6 chain units = 1e9 depot units`
 *    (10% of seed) — too large; use 0.1 USDC = 1e5 chain units = 1e8
 *    depot units (1%).
 *  - **SOL side**: 9-decimal native lamports (passes through), 6-dec
 *    USDC/USDT on SOL, 9-dec LIQSOL. `0.1 SOL = 1e8 lamports` = 1e8
 *    depot units (1%). `0.1 USDC-on-SOL = 1e5 base units` = 1e8 depot
 *    units (1%).
 */
export namespace SwapAmounts {
  // 0.1 ETH in wei (18 decimals).
  export const SourceEthereumWei  = 100_000_000_000_000_000n
  // 0.1 USDC / USDT in chain-native 6-decimal base units (= 1e8 depot
  // units after PrecisionLib scaling).
  export const SourceErc20Stable  = 100_000n
  // 0.1 LIQETH in wei (18 decimals — same scaling as native ETH).
  export const SourceLiqEthWei    = 100_000_000_000_000_000n
  // 0.1 SOL in lamports (9 decimals — passes through).
  export const SourceSolanaLamps  = 100_000_000n
  // 0.1 USDC-on-SOL / USDT-on-SOL in 6-decimal base units.
  export const SourceSplStable    = 100_000n
  // 0.1 LIQSOL in 9-decimal base units (passes through).
  export const SourceLiqSolLamps  = 100_000_000n
}

/**
 * Variance tolerance attached to each SwapRequest.
 *
 * Set wide enough to cover the cumulative slippage of a 1% draw across
 * two constant-product legs (chain → WIRE → chain) plus the depot's
 * 10 bps swap fee. The single-leg quote at 1% input on a 10B/10B
 * reserve is `~99_010_000`; the two-leg chained quote is
 * `~98_039_215`. With a `targetAmount` set conservatively below the
 * two-leg result, 200 bps gives the depot ample room to drift before
 * the variance check fires.
 */
export namespace Variance {
  /** 200 basis points = 2%. */
  export const ToleranceBps = 200
}

/**
 * Expected target-side amounts (used to populate the user-specified
 * `targetAmount` on each SwapRequest). Sized below the depot's
 * `swap_quote` against the seeded 10B/10B reserves with a 1% input
 * through both legs of the chained constant-product curve.
 */
export namespace TargetAmounts {
  /** Match the depot's chained `swap_quote` to within a few bps —
   *  for 1e8 source on a 10B/10B reserve pair, two cp_output legs
   *  through WIRE yield exactly 98_039_215. Set the published target
   *  to the rounded `98_000_000`; the 200 bps tolerance window then
   *  covers both the cp_output remainder and the 10 bps swap fee. */
  export const Default = 98_000_000n
}
