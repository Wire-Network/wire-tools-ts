import { SlugName } from "@wireio/sdk-core"

/**
 * Timing budgets for the variance-revert flow.
 *
 * Mirrors `flow-swap-with-underwriting/tests/constants.ts` so the two
 * suites are mutually intelligible — adjust either together when the
 * cluster's bootstrap or epoch timings shift.
 */
export namespace Timing {
  /** Minimum epoch duration permitted by `epoch-stall-is-fatal.md`. */
  export const EpochDurationSec = 60
  /** Cluster bootstrap budget — 6 min covers full ETH + SOL + WIRE bring-up. */
  export const BootstrapTimeoutMs = 360_000
  /**
   * Negative-assertion wait: how long we sleep before checking that NO
   * UWREQ row was created. Needs to be long enough that the SwapRequest
   * envelope has reached the depot and `createuwreq` has dispatched.
   * One epoch (60s) plus the natural batch-op relay latency.
   */
  export const UwreqNegativeAssertMs = 90_000
  /**
   * Time the SWAP_REVERT outbound has to reach `DEPOT_OUTPOST_ETHEREUM`
   * AND for the ETH outpost to credit the user's refund. The outbound
   * goes through one full epoch (build → emit → batch-op deliver →
   * outpost dispatch), so ≥ 2 epochs.
   */
  export const RevertDeadlineMs = 240_000
  /** Sleep between long-running chain-state polls. */
  export const LongPollIntervalMs = 3_000
}

/**
 * Bootstrap-seeded reserves. Values match `flow-swap-with-underwriting`
 * so both flows can run against the same `ClusterManager.ts::Phase 16c`
 * seed without conflicting.
 */
export namespace Reserves {
  /** chain_amount + wire_amount seed value used by bootstrap. */
  export const InitialAmount = 10_000_000_000n

  export namespace Ethereum {
    export namespace ETH {
      export const ChainCode = SlugName.from("ETHEREUM")
      export const TokenCode = SlugName.from("ETH")
      export const ReserveCode = SlugName.from("PRIMARY")
    }
  }
  export namespace Solana {
    export namespace SOL {
      export const ChainCode = SlugName.from("SOLANA")
      export const TokenCode = SlugName.from("SOL")
      export const ReserveCode = SlugName.from("PRIMARY")
    }
  }
}

/**
 * Source amounts + revert assertion bounds.
 */
export namespace SwapAmounts {
  /**
   * Source wei (1e18) → reserveSeedAmount units (1e9) by /1e9 so the
   * depot's `swap_quote` operates on the same magnitude as the reserve
   * seed. Mirrors `flow-swap-with-underwriting`'s `SwapAmounts.PhaseA`.
   */
  export const SourceEthereumWei = 50_000_000_000_000_000n // 0.05 ETH

  /**
   * Maximum gas (in wei) the variance-revert tx is allowed to consume.
   * `ReserveManager.requestSwap` on anvil settles in ~120k gas at
   * baseFee ~1 gwei; 5e15 wei (0.005 ETH) is well above the ceiling
   * and stays under any realistic anvil-default balance allowance.
   *
   * Used to assert "user spent only gas" after the refund lands.
   */
  export const MaxGasReservedWei = 5_000_000_000_000_000n // 0.005 ETH
}

/**
 * Variance check thresholds.
 */
export namespace Variance {
  /** Acceptable variance in basis points (0.5%). */
  export const ToleranceBps = 50
  /**
   * Multiplier applied to the live quote when constructing the
   * deliberately-inflated `target_amount`. 2× the live quote gives a
   * 10000 bps drift — 200× past the 50 bps tolerance, so the variance
   * branch fires unambiguously regardless of small quote movement
   * between the test's `swapquote` read and the depot's
   * `createuwreq` dispatch.
   */
  export const RevertMultiplier = 2n
}
