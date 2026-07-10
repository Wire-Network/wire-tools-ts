import { SwapStressPhaseAmounts } from "./phaseRunnerTypes.js"
import type {
  EthereumBurstSwapRequest,
  SolanaBurstRequest
} from "./boundedBursts.js"
import type { StressIdentities } from "./stressIdentities.js"
import type {
  Phase2SwapRequest,
  SwapStressPayoutObservationRequest,
  SwapStressPhase,
  SwapStressPayoutTarget,
  SwapStressRouteCodes
} from "./phaseRunnerTypes.js"

/**
 * Build ETH-source burst requests for phase 1.
 *
 * @param route Public ETH to WIRE route constants.
 * @param identities Generated stress identities.
 * @param targetAmounts Quoted WIRE target amounts in submission order.
 * @returns ETH burst requests in identity order.
 */
export function buildPhase1Requests(
  route: SwapStressRouteCodes,
  identities: StressIdentities,
  targetAmounts: readonly bigint[]
): readonly EthereumBurstSwapRequest[] {
  return identities.wire.map((identity, index) => {
    const targetAmount = targetAmounts[index]
    if (targetAmount === undefined)
      throw new RangeError("paired phase-1 target missing")
    return {
      index: identity.index,
      sourceTokenCode: route.ethereumTokenCode,
      sourceReserveCode: route.wireSentinelReserveCode,
      sourceAmountWei: SwapStressPhaseAmounts.Phase1SourceWei,
      targetChainCode: route.wireChainCode,
      targetTokenCode: route.wireTokenCode,
      targetReserveCode: route.wireSentinelReserveCode,
      targetRecipient: identity.accountBytes,
      targetAmount,
      targetToleranceBps: SwapStressPhaseAmounts.TargetToleranceBps
    }
  })
}

/**
 * Build WIRE-source inverse burst requests for phase 2.
 *
 * @param route WIRE to public ETH route constants.
 * @param identities Generated stress identities.
 * @param targetAmounts Quoted ETH target amounts in depot units.
 * @returns WIRE-source burst requests in identity order.
 */
export function buildPhase2Requests(
  route: SwapStressRouteCodes,
  identities: StressIdentities,
  targetAmounts: readonly bigint[]
): readonly SolanaBurstRequest<Phase2SwapRequest>[] {
  return identities.wire.map((identity, index) => {
    const ethereum = identities.ethereum[index],
      targetAmount = targetAmounts[index]
    if (ethereum === undefined)
      throw new RangeError("paired ETH identity missing")
    if (targetAmount === undefined)
      throw new RangeError("paired phase-2 target missing")
    return {
      index,
      request: {
        index,
        sourceAccount: identity.account,
        sourceAmount: SwapStressPhaseAmounts.Phase2SourceWireUnits,
        targetChainCode: route.ethereumChainCode,
        targetTokenCode: route.ethereumTokenCode,
        targetReserveCode: route.wireSentinelReserveCode,
        targetRecipient: ethereum.addressBytes,
        targetAmount,
        targetToleranceBps: SwapStressPhaseAmounts.TargetToleranceBps
      }
    }
  })
}

/**
 * Build the minimum payout observation request for a completed phase.
 *
 * @param phase Completed phase label.
 * @param targets Possible payout destination identities.
 * @param targetAmount Per-recipient target amount in destination base units.
 * @returns Payout observation request requiring at least one visible payout.
 */
export function buildPayoutRequest(
  phase: SwapStressPhase,
  targets: readonly SwapStressPayoutTarget[],
  targetAmount: bigint
): SwapStressPayoutObservationRequest {
  return {
    phase,
    expectedCount: targets.length,
    minimumObservedCount: 1,
    targetAmount,
    targets
  }
}
