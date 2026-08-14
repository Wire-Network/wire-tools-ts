import {
  EthereumFundingTool,
  depositLiqEth,
  type LiqEthDepositTarget
} from "@wireio/cluster-tool/tools/ethereum"
import { Report } from "@wireio/cluster-tool/report"
import type { ClusterBuildContext } from "@wireio/cluster-tool/orchestration"
import { clearNonceCache } from "@wireio/cluster-tool/utils"

const SignerAddress = "0x00000000000000000000000000000000000000b1"

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

describe("depositLiqEth", () => {
  afterEach(() => clearNonceCache(SignerAddress))

  it("uses the shared signer nonce and waits for the confirmed deposit", async () => {
    const getTransactionCount = jest.fn().mockResolvedValue(7),
      wait = jest.fn().mockResolvedValue({ status: 1, hash: "0xconfirmed" }),
      deposit = jest.fn().mockResolvedValue({ wait }),
      depositManager = {
        runner: {
          getAddress: jest.fn().mockResolvedValue(SignerAddress),
          provider: { getTransactionCount }
        },
        deposit
      } as unknown as LiqEthDepositTarget

    await expect(depositLiqEth(depositManager, 42n)).resolves.toBe(
      "0xconfirmed"
    )
    expect(getTransactionCount).toHaveBeenCalledWith(
      SignerAddress.toLowerCase(),
      "latest"
    )
    expect(deposit).toHaveBeenCalledWith({ value: 42n, nonce: 7 })
    expect(wait).toHaveBeenCalledWith(1)
  })

  it("rejects a non-positive deposit before resolving a nonce", async () => {
    await expect(
      depositLiqEth({} as LiqEthDepositTarget, 0n)
    ).rejects.toThrow("liqETH deposit must be > 0")
  })
})
