import { EthereumFundingTool } from "@wireio/cluster-tool/tools/ethereum"
import { Report } from "@wireio/cluster-tool/report"
import type { ClusterBuildContext } from "@wireio/cluster-tool/orchestration"

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

  describe("fundLiqEth", () => {
    it("builds a DepositManager funding Step for an operator", () => {
      const step = EthereumFundingTool.planLiqEthFund(
        Report.Actor.Underwriter,
        "uwa-liqeth-fund",
        "fund liqeth to uwa",
        {},
        "uwa",
        42n
      )
      expect(step.input.kind).toBe("EthereumFundingTool.FundLiqEthInput")
      expect(step.input.operatorLabel).toBe("uwa")
      expect(step.input.amount).toBe(42n)
    })

    it("rejects a non-positive LIQETH balance floor before resolving an operator", async () => {
      await expect(
        EthereumFundingTool.runLiqEthFund(
          {} as ClusterBuildContext,
          {
            kind: "EthereumFundingTool.FundLiqEthInput",
            operatorLabel: "uwa",
            amount: 0n
          },
          new AbortController().signal
        )
      ).rejects.toThrow("amount must be positive")
    })
  })
})
