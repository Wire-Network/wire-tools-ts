import { outputKey, type Books } from "@wireio/cluster-tool"

/**
 * Typed cross-step output keys for the private-reserve swap flow. Each swap
 * phase's quote step SNAPSHOTS the pre-swap state (the two reserve books, the
 * computed WIRE intermediate + target, and the user's destination-side balance
 * baseline); the request/verify steps read the same values back — no shared
 * mutable closures (cross-step values ride `ctx.outputs`).
 */
export namespace SwapPrivateReservesScenarioOutputs {
  /** Phase A (ETH → USDCSOL) pre-swap `(src=ETH, dst=SOL)` reserve books. */
  export const phaseABooksBefore = outputKey<Books>(
    "swapPrivateReserves.phaseA.booksBefore",
    "phase A pre-swap private reserve books (src=ETHEREUM, dst=SOLANA)"
  )
  /** Phase A gross WIRE intermediate `w = cp(eth.chain, eth.wire, source)`. */
  export const phaseAWireIntermediate = outputKey<bigint>(
    "swapPrivateReserves.phaseA.wireIntermediate",
    "phase A gross WIRE intermediate (depot units)"
  )
  /** Phase A user target `cp(sol.wire, sol.chain, w)` (depot units). */
  export const phaseATarget = outputKey<bigint>(
    "swapPrivateReserves.phaseA.target",
    "phase A target amount (depot units)"
  )
  /** Phase A pre-swap USDCSOL balance of the user's ATA (SPL base units). */
  export const phaseAUserAtaBefore = outputKey<bigint>(
    "swapPrivateReserves.phaseA.userAtaBefore",
    "phase A user USDCSOL ATA baseline (base units)"
  )

  /** Phase B (USDCSOL → ETH) pre-swap `(src=SOL, dst=ETH)` reserve books. */
  export const phaseBBooksBefore = outputKey<Books>(
    "swapPrivateReserves.phaseB.booksBefore",
    "phase B pre-swap private reserve books (src=SOLANA, dst=ETHEREUM)"
  )
  /** Phase B gross WIRE intermediate `w = cp(sol.chain, sol.wire, source)`. */
  export const phaseBWireIntermediate = outputKey<bigint>(
    "swapPrivateReserves.phaseB.wireIntermediate",
    "phase B gross WIRE intermediate (depot units)"
  )
  /** Phase B user target `cp(eth.wire, eth.chain, w)` (depot units). */
  export const phaseBTarget = outputKey<bigint>(
    "swapPrivateReserves.phaseB.target",
    "phase B target amount (depot units)"
  )
  /** Phase B pre-swap native-ETH balance of the user's wallet (wei). */
  export const phaseBEthereumBalanceBefore = outputKey<bigint>(
    "swapPrivateReserves.phaseB.ethereumBalanceBefore",
    "phase B user ETH balance baseline (wei)"
  )
}
