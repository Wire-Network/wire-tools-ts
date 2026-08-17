import {
  buildPhase1Requests,
  SwapStressPhaseAmounts
} from "@wireio/test-flow-swap-stress-saturation/swap-stress/index.js"
import type { SwapStressRouteCodes } from "@wireio/test-flow-swap-stress-saturation/swap-stress/index.js"
import { stressIdentities } from "./constants.js"

describe("buildPhase1Requests", () => {
  it("targets WIRE for ETH-to-WIRE stress requests", () => {
    // Given: route codes include both legacy Solana values and the WIRE target values.
    const identities = stressIdentities(),
      targetAmounts = [99_001n, 98_991n]

    // When: phase 1 request payloads are built.
    const requests = buildPhase1Requests(Route, identities, targetAmounts)

    // Then: every request targets the WIRE depot, not Solana recipients or reserves.
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.index)).toEqual([0, 1])
    expect(requests.map(request => request.sourceTokenCode)).toEqual([
      Route.ethereumTokenCode,
      Route.ethereumTokenCode
    ])
    expect(requests.map(request => request.sourceReserveCode)).toEqual([
      Route.wireSentinelReserveCode,
      Route.wireSentinelReserveCode
    ])
    expect(requests.map(request => request.sourceAmountWei)).toEqual([
      SwapStressPhaseAmounts.Phase1SourceWei,
      SwapStressPhaseAmounts.Phase1SourceWei
    ])
    expect(requests.map(request => request.targetChainCode)).toEqual([
      Route.wireChainCode,
      Route.wireChainCode
    ])
    expect(requests.map(request => request.targetTokenCode)).toEqual([
      Route.wireTokenCode,
      Route.wireTokenCode
    ])
    expect(requests.map(request => request.targetReserveCode)).toEqual([
      Route.wireSentinelReserveCode,
      Route.wireSentinelReserveCode
    ])
    expect(
      requests.map(request => Array.from(request.targetRecipient))
    ).toEqual([
      Array.from(identities.wire[0].accountBytes),
      Array.from(identities.wire[1].accountBytes)
    ])
    expect(
      requests.map(request => Array.from(request.targetRecipient))
    ).not.toEqual([
      Array.from(identities.solana[0].publicKeyBytes),
      Array.from(identities.solana[1].publicKeyBytes)
    ])
    expect(requests.map(request => request.targetAmount)).toEqual([
      99_001n,
      98_991n
    ])
  })
})

const Route: SwapStressRouteCodes = {
  ethereumChainCode: 101n,
  ethereumTokenCode: 102n,
  solanaChainCode: 201n,
  solanaTokenCode: 202n,
  wireChainCode: 301n,
  wireTokenCode: 302n,
  wireSentinelReserveCode: 303n,
  privateReserveCode: 401n
}

