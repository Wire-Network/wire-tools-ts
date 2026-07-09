import {
  quoteSwapStressPhase2,
  SwapStressPhaseAmounts
} from "@wireio/test-flow-swap-stress-saturation"
import type { SwapStressReservePairSnapshot } from "@wireio/test-flow-swap-stress-saturation"

describe("quoteSwapStressPhase2", () => {
  it("prices direct WIRE input against the Ethereum reserve", () => {
    // Given: the WIRE-source phase submits swapfromwire directly to ETH/PRIMARY.
    const snapshot: SwapStressReservePairSnapshot = {
      ethereum: { chain: 1_000_000_000_000n, wire: 1_000_000_000_000n },
      solana: { chain: 1_000_000_000n, wire: 1_000_000_000_000n }
    }

    // When: phase 2 computes the swapfromwire quote.
    const quote = quoteSwapStressPhase2(snapshot)

    // Then: the target amount matches sysio.uwrit::drainfwq's WIRE->ETH reserve quote.
    expect(quote.wireIntermediate).toBe(
      SwapStressPhaseAmounts.Phase2SourceWireUnits
    )
    expect(quote.targetAmount).toBe(99_990_000n)
  })
})
