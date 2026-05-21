import { SlugName } from "@wireio/sdk-core"

/**
 * Timing budgets for the bidirectional swap E2E. All deadlines scale
 * from the 60s minimum-epoch rule per `epoch-stall-is-fatal.md`.
 */
export namespace Timing {
  /** Minimum epoch duration permitted by `epoch-stall-is-fatal.md`. */
  export const EpochDurationSec   = 60
  /** Cluster bootstrap budget — 6 min covers full ETH + SOL + WIRE bring-up. */
  export const BootstrapTimeoutMs = 360_000
  /** Time the depot has to insert a UWREQ row after the source outpost emits SWAP_REQUEST. */
  export const UwreqDeadlineMs    = 180_000
  /** Time for the underwriter race to resolve (CONFIRMED status). */
  export const RaceDeadlineMs     = 240_000
  /** Time for the SWAP_REMIT to land on the destination outpost AND credit the user. */
  export const RemitDeadlineMs    = 480_000
  /** Sleep between long-running chain-state polls. */
  export const LongPollIntervalMs = 3_000
}

/**
 * Bootstrap-seeded reserves on the depot. Amounts are populated by
 * `ClusterManager.ts::Phase 16c`; flow-swap-with-underwriting reads
 * them via `WIREClient.getTableRows` rather than re-seeding.
 */
export namespace Reserves {
  /** chain_amount + wire_amount seed value used by bootstrap. */
  export const InitialAmount = 10_000_000_000n

  export namespace Ethereum {
    export namespace ETH {
      export const ChainCode   = SlugName.from("ETHEREUM")
      export const TokenCode   = SlugName.from("ETH")
      export const ReserveCode = SlugName.from("PRIMARY")
    }
  }
  export namespace Solana {
    export namespace SOL {
      export const ChainCode   = SlugName.from("SOLANA")
      export const TokenCode   = SlugName.from("SOL")
      export const ReserveCode = SlugName.from("PRIMARY")
    }
  }
}

/**
 * Per-direction source amounts.
 *
 * The depot's reserve seed (Phase 16c) is 10_000_000_000 = 10B base
 * units in the depot's UNIFORM 9-decimal frame (project rule
 * `feedback-token-precision-9-max`). Each outpost converts its
 * chain-native amount to/from this frame at the OPP boundary via
 * `PrecisionLib`:
 *
 *  - **Ethereum:** `requestSwap(msg.value: uint256 wei)` →
 *    `_toDepotUnits(ETH, msg.value)` = `msg.value / 1e9` (since native
 *    ETH precision is 18 and depot is 9). So `100_000_000 wei` would
 *    underflow to 0 — we need at least `1e9 wei` to register as 1
 *    depot-unit. Use `0.1 ETH = 1e17 wei` ⇒ `1e8` depot units = 1% of
 *    the 10B reserve seed.
 *
 *  - **Solana:** lamports are already 9-decimal — the SOL outpost's
 *    `request_swap` passes `source_amount` straight through to the
 *    envelope. `100_000_000 lamports` = `1e8` depot units = 1% of the
 *    10B reserve seed.
 */
export namespace SwapAmounts {
  export namespace PhaseA {
    /**
     * 0.1 ETH = 1e17 wei. Outpost converts to 1e8 depot-9-dec units
     * (1% of the 10B reserve seed).
     */
    export const SourceEthereumWei = 100_000_000_000_000_000n
  }
  export namespace PhaseB {
    /**
     * 0.1 SOL = 1e8 lamports. SOL precision == depot precision, so
     * this passes through as 1e8 depot-9-dec units (1% of the 10B
     * reserve seed).
     */
    export const SourceSolanaLamports = 100_000_000n
  }
}

/** Variance tolerance the user attaches to each SwapRequest. */
export namespace Variance {
  /** 50 basis points = 0.5%. Generous so quote drift between
   *  request-build and depot-resolve doesn't trip the variance
   *  check during a long E2E run. */
  export const ToleranceBps = 50
}
