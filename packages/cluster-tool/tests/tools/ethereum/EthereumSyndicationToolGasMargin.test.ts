import { EthereumSyndicationTool } from "@wireio/cluster-tool/tools/ethereum"

describe("EthereumSyndicationTool.gasLimitWithMargin", () => {
  it("adds the margin over the estimate", () => {
    expect(EthereumSyndicationTool.gasLimitWithMargin(400_000n)).toBe(500_000n)
    expect(EthereumSyndicationTool.gasLimitWithMargin(0n)).toBe(0n)
  })

  it("never exceeds EIP-7825's per-transaction cap", () => {
    expect(EthereumSyndicationTool.gasLimitWithMargin(16_000_000n)).toBe(
      EthereumSyndicationTool.TransactionGasCap
    )
    expect(EthereumSyndicationTool.gasLimitWithMargin(EthereumSyndicationTool.TransactionGasCap)).toBe(
      EthereumSyndicationTool.TransactionGasCap
    )
  })
})
