import {
  buildPhase2Requests,
  SwapStressPhaseAmounts
} from "@wireio/test-flow-swap-stress-saturation/swap-stress/index.js"
import type { SwapStressRouteCodes } from "@wireio/test-flow-swap-stress-saturation/swap-stress/index.js"
import { stressIdentities } from "./constants.js"

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

