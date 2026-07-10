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
  const wireIntermediate = quoteSwapStressPhase1Targets(snapshot, 1)[0]
  if (wireIntermediate === undefined)
    throw new SwapStressImpossibleQuoteError("phase-1")
  return quote(
    "phase-1",
    snapshot.ethereum,
    snapshot.solana,
    SwapStressPhaseAmounts.Phase1SourceDepotUnits,
    wireIntermediate
  )
}

/**
 * Compute per-request ETH -> WIRE targets for one phase-1 burst.
 *
 * @param snapshot Live ETH public and SOL private reserve rows.
 * @param count Number of queued ETH-source swaps in the burst.
 * @returns WIRE target amounts in submission order.
 */
export function quoteSwapStressPhase1Targets(
  snapshot: SwapStressReservePairSnapshot,
  count: number
): readonly bigint[] {
  const sourceAmount = SwapStressPhaseAmounts.Phase1SourceDepotUnits,
    targets = Array.from({ length: count }).reduce<{
      readonly targets: readonly bigint[]
      readonly chain: bigint
      readonly wire: bigint
    }>(
      (state): {
        readonly targets: readonly bigint[]
        readonly chain: bigint
        readonly wire: bigint
      } => {
        const targetAmount = cpOutput(state.chain, state.wire, sourceAmount)
        if (targetAmount <= 0n)
          throw new SwapStressImpossibleQuoteError("phase-1")
        return {
          targets: [...state.targets, targetAmount],
          chain: state.chain + sourceAmount,
          wire: state.wire - targetAmount
        }
      },
      {
        targets: [],
        chain: snapshot.ethereum.chain,
        wire: snapshot.ethereum.wire
      }
    )
  return targets.targets
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
  const targetAmount = quoteSwapStressPhase2Targets(snapshot, 1)[0]
  if (targetAmount === undefined)
    throw new SwapStressImpossibleQuoteError("phase-2")
  return {
    wireIntermediate: SwapStressPhaseAmounts.Phase2SourceWireUnits,
    targetAmount
  }
}

/**
 * Compute per-request WIRE -> ETH targets for one phase-2 burst.
 *
 * @param snapshot Live ETH public and SOL private reserve rows.
 * @param count Number of queued WIRE-source swaps in the burst.
 * @returns ETH target amounts in submission order.
 */
export function quoteSwapStressPhase2Targets(
  snapshot: SwapStressReservePairSnapshot,
  count: number
): readonly bigint[] {
  const sourceAmount = SwapStressPhaseAmounts.Phase2SourceWireUnits,
    targets = Array.from({ length: count }).reduce<{
      readonly targets: readonly bigint[]
      readonly wire: bigint
      readonly chain: bigint
    }>(
      (state): {
        readonly targets: readonly bigint[]
        readonly wire: bigint
        readonly chain: bigint
      } => {
        const targetAmount = cpOutput(state.wire, state.chain, sourceAmount)
        if (targetAmount <= 0n)
          throw new SwapStressImpossibleQuoteError("phase-2")
        return {
          targets: [...state.targets, targetAmount],
          wire: state.wire + sourceAmount,
          chain: state.chain - targetAmount
        }
      },
      {
        targets: [],
        wire: snapshot.ethereum.wire,
        chain: snapshot.ethereum.chain
      }
    )
  return targets.targets
}

function quote(
  phase: SwapStressPhase,
  source: SwapStressReserveRowSnapshot,
  destination: SwapStressReserveRowSnapshot,
  sourceAmount: bigint,
  knownWireIntermediate?: bigint
): SwapStressPhaseQuote {
  const wireIntermediate =
      knownWireIntermediate ?? cpOutput(source.chain, source.wire, sourceAmount),
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
