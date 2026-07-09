import {
  SwapStressImpossibleQuoteError,
  SwapStressPhaseAmounts
} from "./phaseRunnerTypes.js"
import type {
  SwapStressPhase,
  SwapStressReservePairSnapshot,
  SwapStressReserveRowSnapshot
} from "./phaseRunnerTypes.js"

/** Constant-product quote for one stress phase. */
export type SwapStressPhaseQuote = {
  /** WIRE amount produced by the source reserve leg. */
  readonly wireIntermediate: bigint
  /** Destination-chain target amount produced by the destination reserve leg. */
  readonly targetAmount: bigint
}

/**
 * Compute the live ETH -> WIRE stress quote.
 *
 * @param snapshot Live ETH public and SOL private reserve rows.
 * @returns Phase 1 WIRE target and unused paired target.
 */
export function quoteSwapStressPhase1(
  snapshot: SwapStressReservePairSnapshot
): SwapStressPhaseQuote {
  return quote(
    "phase-1",
    snapshot.ethereum,
    snapshot.solana,
    SwapStressPhaseAmounts.Phase1SourceDepotUnits
  )
}

/**
 * Compute the live WIRE -> ETH stress quote.
 *
 * @param snapshot Live ETH public and SOL private reserve rows.
 * @returns Phase 2 direct WIRE input and destination target.
 */
export function quoteSwapStressPhase2(
  snapshot: SwapStressReservePairSnapshot
): SwapStressPhaseQuote {
  const wireIntermediate = SwapStressPhaseAmounts.Phase2SourceWireUnits,
    targetAmount = cpOutput(
      snapshot.ethereum.wire,
      snapshot.ethereum.chain,
      wireIntermediate
    )
  if (targetAmount <= 0n) throw new SwapStressImpossibleQuoteError("phase-2")
  return { wireIntermediate, targetAmount }
}

function quote(
  phase: SwapStressPhase,
  source: SwapStressReserveRowSnapshot,
  destination: SwapStressReserveRowSnapshot,
  sourceAmount: bigint
): SwapStressPhaseQuote {
  const wireIntermediate = cpOutput(source.chain, source.wire, sourceAmount),
    targetAmount = cpOutput(
      destination.wire,
      destination.chain,
      wireIntermediate
    )
  if (wireIntermediate <= 0n || targetAmount <= 0n)
    throw new SwapStressImpossibleQuoteError(phase)
  return { wireIntermediate, targetAmount }
}

function cpOutput(
  reserveSource: bigint,
  reserveDestination: bigint,
  sourceAmount: bigint
): bigint {
  if (reserveSource <= 0n || reserveDestination <= 0n || sourceAmount <= 0n)
    return 0n
  return (reserveDestination * sourceAmount) / (reserveSource + sourceAmount)
}
