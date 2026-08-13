import { AnvilProcess } from "@wireio/cluster-tool"

describe("AnvilProcess.gasArgs", () => {
  it("enforces mainnet parity by default: pinned fork, per-tx cap, sized block", () => {
    // Given/When: the default (not uncapped).
    const args = AnvilProcess.gasArgs(false)

    // Then: all three constraints ride together. --enable-tx-gas-limit is what
    // enforces EIP-7825's per-transaction cap; anvil does NOT apply it merely
    // because the hardfork is selected.
    expect(args).toEqual([
      "--hardfork",
      AnvilProcess.Hardfork,
      "--enable-tx-gas-limit",
      "--gas-limit",
      String(AnvilProcess.BlockGasLimit)
    ])
  })

  it("drops the per-tx cap and raises the block ceiling when uncapped", () => {
    // Given/When: the investigation-only regime.
    const args = AnvilProcess.gasArgs(true)

    // Then: the per-tx cap is GONE — that is the point, it is the constraint
    // being ruled out — and the block ceiling clears ETH-241's ~93.6M case.
    expect(args).not.toContain("--enable-tx-gas-limit")
    expect(args).toEqual([
      "--hardfork",
      AnvilProcess.Hardfork,
      "--gas-limit",
      String(AnvilProcess.UncappedBlockGasLimit)
    ])
    expect(AnvilProcess.UncappedBlockGasLimit).toBeGreaterThan(93_600_000)
  })

  it("never emits the flag pair anvil rejects", () => {
    // --gas-limit cannot be combined with --disable-block-gas-limit; anvil
    // exits 2. An earlier cut shipped exactly that pair, passed its unit test,
    // and killed a live run in the outpost-deploy phase.
    ;[false, true].forEach(uncapped => {
      const args = AnvilProcess.gasArgs(uncapped)
      expect(
        args.includes("--gas-limit") &&
          args.includes("--disable-block-gas-limit")
      ).toBe(false)
    })
  })

  it("pins the ceiling ordering: parity below uncapped", () => {
    expect(AnvilProcess.BlockGasLimit).toBeLessThan(
      AnvilProcess.UncappedBlockGasLimit
    )
  })
})
