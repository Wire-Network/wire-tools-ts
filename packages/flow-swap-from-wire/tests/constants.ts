import { SlugName } from "@wireio/sdk-core"

/** Timing budgets — 60s epochs per `epoch-stall-is-fatal.md`. */
export namespace Timing {
  export const EpochDurationSec   = 60
  export const BootstrapTimeoutMs = 360_000
  /**
   * swapfromwire is QUEUED — the PENDING uwreq materialises at the next
   * `sysio.epoch::advance` (drainfwq). Budget two epochs + relay slack.
   */
  export const DrainDeadlineMs    = 180_000
  /** Single-leg underwriter race (target commit only). */
  export const RaceDeadlineMs     = 240_000
  /** SWAP_REMIT delivery to the SOL outpost + recipient credit. */
  export const RemitDeadlineMs    = 480_000
  export const LongPollIntervalMs = 3_000
}

export namespace Reserves {
  export namespace Solana {
    export namespace SOL {
      export const ChainCode   = SlugName.from("SOLANA")
      export const TokenCode   = SlugName.from("SOL")
      export const ReserveCode = SlugName.from("PRIMARY")
    }
  }
  export namespace Wire {
    export const ChainCode = SlugName.from("WIRE")
    export const TokenCode = SlugName.from("WIRE")
  }
  export const InitialAmount = 10_000_000_000n
}

export namespace SwapAmounts {
  /**
   * 0.1 WIRE = 1e8 base units escrowed by the depositor — ~1% of the
   * seeded SOL reserve, comfortably inside variance tolerance. WIRE and
   * SOL (lamports) share the 9-decimal frame, so no precision scaling.
   */
  export const SourceWireUnits = 100_000_000n
}

export namespace Variance {
  export const ToleranceBps = 500
}

export namespace Accounts {
  /** Swap-from-WIRE depositor — funded with WIRE at provisioning. */
  export const Depositor = "wirefromusr"
  /** Funding: 10× the escrow so repeated runs in one cluster still work. */
  export const DepositorFunding = 1_000_000_000n
}
