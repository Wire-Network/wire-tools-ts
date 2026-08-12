import { EthereumGasPolicy } from "@wireio/cluster-tool-shared"

import { AnvilProcess } from "@wireio/cluster-tool"

describe("AnvilProcess.gasPolicyArgs", () => {
  it("adds nothing for the stock chain", () => {
    // Given/When: the default policy.
    const args = AnvilProcess.gasPolicyArgs(EthereumGasPolicy.chainDefault)

    // Then: anvil's own defaults apply — 30M block gas, EIP-7825 unenforced.
    expect(args).toEqual([])
  })

  it("enforces the EIP-7825 per-transaction cap for osaka", () => {
    // Given/When: the Osaka policy.
    const args = AnvilProcess.gasPolicyArgs(EthereumGasPolicy.osaka)

    // Then: anvil gates EIP-7825 behind an explicit opt-in, so the flag is
    // required — selecting the hardfork alone does NOT enforce the cap.
    expect(args).toEqual([
      "--hardfork",
      AnvilProcess.OsakaHardfork,
      "--enable-tx-gas-limit"
    ])
  })

  it("raises the block ceiling for uncapped", () => {
    // Given/When: the uncapped policy.
    const args = AnvilProcess.gasPolicyArgs(EthereumGasPolicy.uncapped)

    // Then: both the block limit and the call<=block constraint are lifted.
    expect(args).toEqual(["--gas-limit", AnvilProcess.UncappedBlockGasLimit])
    // And: the limit clears the ~93.6M worst case ETH-241 describes.
    expect(Number(AnvilProcess.UncappedBlockGasLimit)).toBeGreaterThan(
      93_600_000
    )
  })

  it("never enables the transaction cap unless osaka is selected", () => {
    // Given: every policy that is not osaka.
    const others = [
      EthereumGasPolicy.chainDefault,
      EthereumGasPolicy.uncapped
    ]

    // Then: the EIP-7825 opt-in appears for osaka alone.
    others.forEach(policy =>
      expect(AnvilProcess.gasPolicyArgs(policy)).not.toContain(
        "--enable-tx-gas-limit"
      )
    )
  })
})
