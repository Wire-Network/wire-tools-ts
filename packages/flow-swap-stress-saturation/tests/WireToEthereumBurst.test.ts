import {
  buildPhase2Requests,
  SwapStressPhaseAmounts
} from "@wireio/test-flow-swap-stress-saturation"
import type {
  StressIdentities,
  SwapStressRouteCodes
} from "@wireio/test-flow-swap-stress-saturation"

describe("buildPhase2Requests", () => {
  it("builds WIRE-to-ETH stress requests without Solana source semantics", () => {
    // Given: paired identities and route codes include legacy Solana values plus Ethereum target values.
    const identities = stressIdentities(),
      targetAmounts = [88_002n, 87_991n]

    // When: phase 2 request payloads are built.
    const requests = buildPhase2Requests(Route, identities, targetAmounts)

    // Then: requests escrow WIRE on the depot and target generated Ethereum recipients.
    expect(requests).toHaveLength(2)
    expect(requests.map(request => request.index)).toEqual([0, 1])
    expect(requests.map(request => request.request.index)).toEqual([0, 1])
    expect(requests.map(request => request.request.sourceAccount)).toEqual([
      identities.wire[0].account,
      identities.wire[1].account
    ])
    expect(requests.map(request => request.request.sourceAmount)).toEqual([
      SwapStressPhaseAmounts.Phase2SourceWireUnits,
      SwapStressPhaseAmounts.Phase2SourceWireUnits
    ])
    expect(requests.map(request => request.request.targetChainCode)).toEqual([
      Route.ethereumChainCode,
      Route.ethereumChainCode
    ])
    expect(requests.map(request => request.request.targetTokenCode)).toEqual([
      Route.ethereumTokenCode,
      Route.ethereumTokenCode
    ])
    expect(requests.map(request => request.request.targetReserveCode)).toEqual([
      Route.wireSentinelReserveCode,
      Route.wireSentinelReserveCode
    ])
    expect(
      requests.map(request => Array.from(request.request.targetRecipient))
    ).toEqual([
      Array.from(identities.ethereum[0].addressBytes),
      Array.from(identities.ethereum[1].addressBytes)
    ])
    expect(requests.map(request => request.request.targetAmount)).toEqual([
      88_002n,
      87_991n
    ])
    expect(requests.map(request => request.request.targetToleranceBps)).toEqual(
      [
        SwapStressPhaseAmounts.TargetToleranceBps,
        SwapStressPhaseAmounts.TargetToleranceBps
      ]
    )
    expect(requests.map(request => request.request)).toEqual([
      expect.not.objectContaining({ sourcePublicKey: expect.anything() }),
      expect.not.objectContaining({ sourcePublicKey: expect.anything() })
    ])
    expect(requests.map(request => request.request)).toEqual([
      expect.not.objectContaining({ sourceSecretKey: expect.anything() }),
      expect.not.objectContaining({ sourceSecretKey: expect.anything() })
    ])
    expect(requests.map(request => request.request)).toEqual([
      expect.not.objectContaining({ sourceTokenCode: expect.anything() }),
      expect.not.objectContaining({ sourceTokenCode: expect.anything() })
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
