import {
  buildPhase1Requests,
  SwapStressPhaseAmounts
} from "@wireio/test-flow-swap-stress-saturation"
import type {
  StressIdentities,
  SwapStressRouteCodes
} from "@wireio/test-flow-swap-stress-saturation"

describe("buildPhase1Requests", () => {
  it("targets WIRE for ETH-to-WIRE stress requests", () => {
    // Given: route codes include both legacy Solana values and the WIRE target values.
    const identities = stressIdentities(),
      targetAmount = 99_001n

    // When: phase 1 request payloads are built.
    const requests = buildPhase1Requests(Route, identities, targetAmount)

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
      targetAmount,
      targetAmount
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

function stressIdentities(): StressIdentities {
  return {
    ethereum: [
      {
        index: 0,
        hdIndex: 128,
        address: "0x0000000000000000000000000000000000000001",
        addressBytes: new Uint8Array([1])
      },
      {
        index: 1,
        hdIndex: 129,
        address: "0x0000000000000000000000000000000000000002",
        addressBytes: new Uint8Array([2])
      }
    ],
    solana: [
      {
        index: 0,
        publicKey: "sol-0",
        publicKeyBytes: new Uint8Array([10]),
        secretKey: new Uint8Array([20])
      },
      {
        index: 1,
        publicKey: "sol-1",
        publicKeyBytes: new Uint8Array([11]),
        secretKey: new Uint8Array([21])
      }
    ],
    wire: [
      { index: 0, account: "stressw0", accountBytes: new Uint8Array([30]) },
      { index: 1, account: "stressw1", accountBytes: new Uint8Array([31]) }
    ]
  }
}
