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
})
