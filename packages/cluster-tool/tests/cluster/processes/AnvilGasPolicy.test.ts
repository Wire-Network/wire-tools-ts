import { EthereumGasPolicy } from "@wireio/cluster-tool-shared"

import { AnvilProcess } from "@wireio/cluster-tool"

describe("AnvilProcess.gasPolicyArgs", () => {
  it("enforces mainnet parity by default: pinned fork, per-tx cap, sized block", () => {
    // Given/When: the default regime.
    const args = AnvilProcess.gasPolicyArgs(EthereumGasPolicy.mainnetParity)

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

  it("drops the per-tx cap and raises the block ceiling for uncapped", () => {
    // Given/When: the investigation-only regime.
    const args = AnvilProcess.gasPolicyArgs(EthereumGasPolicy.uncapped)

    // Then: the per-tx cap is GONE (that is the point — it is the constraint
    // being ruled out) and the block ceiling clears ETH-241's ~93.6M worst case.
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
    // exits 2. An earlier cut of `uncapped` shipped exactly that pair, passed
    // its unit test, and killed a live run in the outpost-deploy phase.
    Object.values(EthereumGasPolicy).forEach(policy => {
      const args = AnvilProcess.gasPolicyArgs(policy)
      expect(
        args.includes("--gas-limit") && args.includes("--disable-block-gas-limit")
      ).toBe(false)
    })
  })

  it("pins the block ceiling ordering: parity below uncapped", () => {
    expect(AnvilProcess.BlockGasLimit).toBeLessThan(
      AnvilProcess.UncappedBlockGasLimit
    )
  })
})
