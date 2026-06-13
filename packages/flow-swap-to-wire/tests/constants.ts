import { SlugName } from "@wireio/sdk-core"

/**
 * Timing budgets — same scaling rules as flow-swap-with-underwriting
 * (60s epochs per `epoch-stall-is-fatal.md`).
 */
export namespace Timing {
  export const EpochDurationSec   = 60
  export const BootstrapTimeoutMs = 360_000
  /** SWAP_REQUEST relay + UWREQ insert. */
  export const UwreqDeadlineMs    = 180_000
  /** Single-leg underwriter race (source commit only). */
  export const RaceDeadlineMs     = 240_000
  /**
   * Direct WIRE payout window. The depot pays in the SAME transaction
   * that resolves the race — no destination outpost round-trip — so this
   * is shorter than the cross-chain remit deadline.
   */
  export const PayoutDeadlineMs   = 120_000
  export const LongPollIntervalMs = 3_000
}

/** Bootstrap-seeded reserves consumed by this flow. */
export namespace Reserves {
  export namespace Ethereum {
    export namespace ETH {
      export const ChainCode   = SlugName.from("ETHEREUM")
      export const TokenCode   = SlugName.from("ETH")
      export const ReserveCode = SlugName.from("PRIMARY")
    }
  }
  /**
   * The WIRE target identity. The depot pays WIRE directly — there is no
   * WIRE-side reserve — but the outposts require a NON-ZERO
   * targetReserveCode, so the PRIMARY sentinel rides the SwapRequest and
   * is never quoted or debited.
   */
  export namespace Wire {
    export const ChainCode           = SlugName.from("WIRE")
    export const TokenCode           = SlugName.from("WIRE")
    export const SentinelReserveCode = SlugName.from("PRIMARY")
  }
  /** chain/wire seed amount per bootstrap Phase 16c. */
  export const InitialAmount = 10_000_000_000n
}

export namespace SwapAmounts {
  /**
   * 0.1 ETH = 1e17 wei → 1e8 depot units (the ETH outpost divides native
   * wei by 1e9 into the uniform 9-decimal depot frame). ~1% of the seeded
   * reserve, so slippage stays well inside the tolerance.
   */
  export const SourceEthereumWei = 100_000_000_000_000_000n
  export const SourceDepotUnits  = SourceEthereumWei / 10n ** 9n
}

export namespace Variance {
  /** 5% — generous so quote drift between poll and race never reverts. */
  export const ToleranceBps = 500
}

export namespace Accounts {
  /** Swap-to-WIRE recipient — exists, holds no WIRE until the payout. */
  export const Recipient = "wirercpt"
}
