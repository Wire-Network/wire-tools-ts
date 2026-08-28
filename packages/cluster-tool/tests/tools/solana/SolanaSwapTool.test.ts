import { parseSolanaSwapSourceRequestId } from "@wireio/cluster-tool/tools/solana"

describe("parseSolanaSwapSourceRequestId", () => {
  it("reads the canonical SwapDeposit marker", () => {
    expect(
      parseSolanaSwapSourceRequestId([
        "Program log: opp_outpost: SwapDeposit id=42 hash=abc"
      ])
    ).toBe(42n)
  })

  it("rejects confirmed logs without the marker", () => {
    expect(() => parseSolanaSwapSourceRequestId([])).toThrow(
      /did not log SwapDeposit/
    )
  })
})
