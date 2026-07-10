import {
  quoteSwapStressPhase1Targets,
  quoteSwapStressPhase2Targets,
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

  it("prices a phase-2 burst against the post-drain reserve ladder", () => {
    // Given: three WIRE-source swaps will drain the same Ethereum reserve.
    const snapshot: SwapStressReservePairSnapshot = {
      ethereum: { chain: 1_000_000_000_000n, wire: 1_000_000_000_000n },
      solana: { chain: 1_000_000_000n, wire: 1_000_000_000_000n }
    }

    // When: phase 2 computes one target per queued swap.
    const targets = quoteSwapStressPhase2Targets(snapshot, 3)

    // Then: each target matches the reserve state after prior swaps drain.
    expect(targets).toEqual([99_990_000n, 99_970_006n, 99_950_018n])
  })
})

describe("quoteSwapStressPhase1", () => {
  it("prices a phase-1 burst against the post-drain reserve ladder", () => {
    // Given: three ETH-source swaps will drain WIRE from the same Ethereum reserve.
    const snapshot: SwapStressReservePairSnapshot = {
      ethereum: { chain: 1_000_000_000_000n, wire: 1_000_000_000_000n },
      solana: { chain: 1_000_000_000n, wire: 1_000_000_000_000n }
    }

    // When: phase 1 computes one WIRE target per queued swap.
    const targets = quoteSwapStressPhase1Targets(snapshot, 3)

    // Then: each target matches the reserve state after prior swaps drain.
    expect(targets).toEqual([99_990_000n, 99_970_006n, 99_950_018n])
  })
})
