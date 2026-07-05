import { outputKey, type ReserveBook } from "@wireio/cluster-tool"

/**
 * Typed cross-step outputs for the swap-from-WIRE scenario — every baseline and
 * computed target rides `ctx.outputs` under these keys (never a shared mutable
 * closure). The QuoteAndEscrow phase writes them; the race / remit / drain
 * verifications read them back.
 */
export namespace SwapFromWireScenarioOutputs {
  /** Constant-product target (lamports) quoted off the destination reserve curve. */
  export const targetSolanaAmount = outputKey<bigint>(
    "fromWire.targetSolanaAmount",
    "quoted SOL target amount (lamports)"
  )

  /** The SOLANA/SOL/PRIMARY reserve `(chain, wire)` book before the swap. */
  export const solanaReserveBefore = outputKey<ReserveBook>(
    "fromWire.solanaReserveBefore",
    "destination reserve book baseline"
  )

  /** The depositor's real WIRE balance before the `swapfromwire` escrow. */
  export const depositorWireBefore = outputKey<bigint>(
    "fromWire.depositorWireBefore",
    "depositor WIRE balance baseline"
  )

  /** `sysio.reserv`'s real WIRE custody balance before the escrow. */
  export const reserveCustodyBefore = outputKey<bigint>(
    "fromWire.reserveCustodyBefore",
    "sysio.reserv WIRE custody baseline"
  )

  /** The Solana recipient's lamport balance before the swap. */
  export const recipientLamportsBefore = outputKey<number>(
    "fromWire.recipientLamportsBefore",
    "recipient lamport balance baseline"
  )
}
