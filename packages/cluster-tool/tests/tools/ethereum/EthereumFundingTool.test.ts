import { EthereumFundingTool } from "@wireio/cluster-tool/tools/ethereum"
import { Report } from "@wireio/cluster-tool/report"

describe("EthereumFundingTool step factories", () => {
  describe("mintErc20", () => {
    it("builds a mint Step carrying the operator + token + amount input", () => {
      const step = EthereumFundingTool.planErc20Mint(
        Report.Actor.Underwriter,
        "uwa-usdc-mint",
        "mint usdc to uwa",
        {},
        "uwa",
        "USDC",
        42n
      )
      expect(step.actor).toBe(Report.Actor.Underwriter)
      expect(step.name).toBe("uwa-usdc-mint")
      expect(step.input.kind).toBe("EthereumFundingTool.MintErc20Input")
      expect(step.input.operatorLabel).toBe("uwa")
      expect(step.input.tokenName).toBe("USDC")
      expect(step.input.amount).toBe(42n)
    })
  })

  describe("mintErc20ToSwapUser", () => {
    it("builds a mint Step carrying the token and balance floor", () => {
      const step = EthereumFundingTool.planErc20MintToSwapUser(
        Report.Actor.User,
        "swap-user-usdc-mint",
        "mint usdc to the swap user",
        {},
        "USDC",
        84n
      )
      expect(step.actor).toBe(Report.Actor.User)
      expect(step.input.kind).toBe(
        "EthereumFundingTool.MintErc20ToSwapUserInput"
      )
      expect(step.input.tokenName).toBe("USDC")
      expect(step.input.amount).toBe(84n)
    })

    it("rejects a non-positive balance floor before resolving context", async () => {
      await expect(
        EthereumFundingTool.runErc20MintToSwapUser(
          null as never,
          {
            kind: "EthereumFundingTool.MintErc20ToSwapUserInput",
            tokenName: "USDC",
            amount: 0n
          },
          new AbortController().signal
        )
      ).rejects.toThrow(/amount must be positive/)
    })
  })
})
