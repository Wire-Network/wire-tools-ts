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
 */
export namespace Variance {
  /** 50 basis points = 0.5%. */
  export const ToleranceBps = 50
}

/**
 * Expected target-side amounts (used to populate the user-specified
 * `targetAmount` on each SwapRequest). Sized to be inside the
 * variance-tolerance window of what the depot's `swapquote` will
 * produce against the seeded 10B/10B reserves with a constant-product
 * curve.
 */
export namespace TargetAmounts {
  /** Generic conservative target — depot's swap_quote against the
   *  seeded 10B/10B reserves with 1% input typically lands close to
   *  the geometric mean. Pick a value that's inside the 50 bps
   *  variance window. */
  export const Default = 99_000_000n // 1e8 minus 1% — inside the 50 bps tolerance.
}
