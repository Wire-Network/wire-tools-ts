import { ethers } from "ethers"
import { ChainKind } from "@wireio/opp-typescript-models"
import {
  ClusterBuild,
  ClusterBuildContext,
  ClusterBuildStep
} from "@wireio/cluster-tool/orchestration"
import { MockShadowBackingSteps } from "@wireio/cluster-tool/orchestration/steps"
import {
  MockShadowBackingSolanaRequiredKey,
  MockShadowBackingEthereumRequiredKey,
  MockShadowBackingEthereumPrincipalKey
} from "@wireio/cluster-tool/orchestration/outputs"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import {
  EthereumFundingTool,
  EthereumSyndicationTool
} from "@wireio/cluster-tool/tools/ethereum"
import {
  SolanaFundingTool,
  SolanaLiqSyndicationTool
} from "@wireio/cluster-tool/tools/solana"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

const actor = Report.Actor.User
const signal = new AbortController().signal

describe("MockShadowBackingSteps", () => {
  let context: ClusterBuildContext
  beforeEach(() => {
    context = new ClusterBuildContext(
      fixtureConfig(),
      getLogger("mock-shadow-backing-test")
    )
    jest
      .spyOn(EthereumSyndicationTool, "readSyndicatedPrincipal")
      .mockResolvedValue(110_000_000_000n)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("composes separate read, funding, deposit, donation and verify checkpoints", () => {
    const build = ClusterBuild.forContext(context),
      solana = MockShadowBackingSteps.planSolana(build),
      ethereum = MockShadowBackingSteps.planEthereum(build)
    expect(solana.steps.map(step => step.runner)).toEqual([
      MockShadowBackingSteps.runReadCustody,
      MockShadowBackingSteps.runAirdropSolana,
      MockShadowBackingSteps.runDepositSolana,
      MockShadowBackingSteps.runDonateSolana,
      MockShadowBackingSteps.runVerifyCustody
    ])
    expect(ethereum.steps.map(step => step.runner)).toEqual([
      MockShadowBackingSteps.runReadCustody,
      MockShadowBackingSteps.runFundEthereum,
      MockShadowBackingSteps.runDepositEthereum,
      MockShadowBackingSteps.runDonateEthereum,
      MockShadowBackingSteps.runVerifyCustody
    ])
  })

  it("names the backer's persisted handles and the fee margins", () => {
    // The backer is a wallet of its own on BOTH chains — never the deployer, an
    // operator or the panic account.
    expect(MockShadowBackingSteps.EthereumBackerLabel).toBe("mock-shadow-backer")
    expect(MockShadowBackingSteps.SolanaBackerLabel).toBe("mock-shadow-backer")
    expect(MockShadowBackingSteps.EthereumFundingMargin).toBe(ethers.WeiPerEther)
    expect(MockShadowBackingSteps.SolanaFundingMargin).toBeGreaterThan(0n)
  })

  it.each([ChainKind.SVM, ChainKind.EVM] as const)(
    "funds the full outstanding when custody is empty for %s",
    async chain => {
      jest
        .spyOn(WireSyndicationTool, "readOutstanding")
        .mockResolvedValue(110_000_000_000n)
      jest
        .spyOn(SolanaLiqSyndicationTool, "readPoolBalance")
        .mockResolvedValue(0n)
      jest
        .spyOn(EthereumSyndicationTool, "readPoolBalanceDepot")
        .mockResolvedValue(0n)
      const step = MockShadowBackingSteps.planReadCustody(
        actor,
        "read",
        "read",
        {},
        chain
      )
      await step.runner(context, step.input, signal)
      const solana = chain === ChainKind.SVM
      expect(
        context.outputs.assert(
          solana
            ? MockShadowBackingSolanaRequiredKey
            : MockShadowBackingEthereumRequiredKey
        )
      ).toBe(
        110_000_000_000n *
          (solana ? 1n : MockShadowBackingSteps.EthereumWeiPerDepotUnit)
      )
      expect(WireSyndicationTool.readOutstanding).toHaveBeenCalledWith(
        context,
        solana ? "LIQSOL" : "LIQETH"
      )
    }
  )

  it.each([ChainKind.SVM, ChainKind.EVM] as const)(
    "funds only the shortfall with partial custody for %s",
    async chain => {
      const backing = 110_000_000_000n,
        custody = 10_000_000_000n,
        shortfall = 100_000_000_000n,
        solana = chain === ChainKind.SVM
      jest
        .spyOn(WireSyndicationTool, "readOutstanding")
        .mockResolvedValue(backing)
      jest
        .spyOn(SolanaLiqSyndicationTool, "readPoolBalance")
        .mockResolvedValue(custody)
      jest
        .spyOn(EthereumSyndicationTool, "readPoolBalanceDepot")
        .mockResolvedValue(custody)
      const step = MockShadowBackingSteps.planReadCustody(
        actor,
        "read",
        "read",
        {},
        chain
      )
      await step.runner(context, step.input, signal)
      const nativeRequired = context.outputs.assert(
          solana
            ? MockShadowBackingSolanaRequiredKey
            : MockShadowBackingEthereumRequiredKey
        ),
        scale = solana ? 1n : MockShadowBackingSteps.EthereumWeiPerDepotUnit
      expect(nativeRequired).toBe(shortfall * scale)
      expect(custody + nativeRequired / scale).toBe(backing)
      if (!solana) {
        expect(
          context.outputs.assert(MockShadowBackingEthereumPrincipalKey)
        ).toBe(backing)
      }
    }
  )

  it.each([ChainKind.SVM, ChainKind.EVM] as const)(
    "does not acquire backing when custody already covers %s",
    async chain => {
      jest
        .mocked(EthereumSyndicationTool.readSyndicatedPrincipal)
        .mockResolvedValue(10n)
      jest.spyOn(WireSyndicationTool, "readOutstanding").mockResolvedValue(10n)
      jest
        .spyOn(SolanaLiqSyndicationTool, "readPoolBalance")
        .mockResolvedValue(10n)
      jest
        .spyOn(EthereumSyndicationTool, "readPoolBalanceDepot")
        .mockResolvedValue(11n)
      const step = MockShadowBackingSteps.planReadCustody(
        actor,
        "read",
        "read",
        {},
        chain
      )
      await step.runner(context, step.input, signal)
      expect(
        context.outputs.assert(
          chain === ChainKind.SVM
            ? MockShadowBackingSolanaRequiredKey
            : MockShadowBackingEthereumRequiredKey
        )
      ).toBe(0n)
    }
  )

  it("propagates a custody RPC failure without publishing an amount", async () => {
    jest.spyOn(WireSyndicationTool, "readOutstanding").mockResolvedValue(10n)
    jest
      .spyOn(SolanaLiqSyndicationTool, "readPoolBalance")
      .mockRejectedValue(new Error("RPC refused"))
    const step = MockShadowBackingSteps.planReadCustody(
      actor,
      "read",
      "read",
      {},
      ChainKind.SVM
    )
    await expect(step.runner(context, step.input, signal)).rejects.toThrow(
      "RPC refused"
    )
    expect(context.outputs.get(MockShadowBackingSolanaRequiredKey)).toBeNull()
  })

  it.each([ChainKind.SVM, ChainKind.EVM] as const)(
    "verifies coverage and refuses a shortfall for %s",
    async chain => {
      jest.spyOn(WireSyndicationTool, "readOutstanding").mockResolvedValue(10n)
      jest
        .spyOn(SolanaLiqSyndicationTool, "readPoolBalance")
        .mockResolvedValueOnce(10n)
        .mockResolvedValue(9n)
      jest
        .spyOn(EthereumSyndicationTool, "readPoolBalanceDepot")
        .mockResolvedValueOnce(10n)
        .mockResolvedValue(9n)
      context.outputs.set(MockShadowBackingEthereumPrincipalKey, 10n)
      jest
        .spyOn(EthereumSyndicationTool, "readSyndicatedPrincipal")
        .mockResolvedValue(10n)
      const step = MockShadowBackingSteps.planVerifyCustody(
        actor,
        "verify",
        "verify",
        {},
        chain
      )
      await step.runner(context, step.input, signal)
      await expect(step.runner(context, step.input, signal)).rejects.toThrow(
        "custody shortfall"
      )
    }
  )

  it("rejects covered custody with unseeded principal", async () => {
    context.outputs.set(MockShadowBackingEthereumPrincipalKey, 10n)
    jest.spyOn(WireSyndicationTool, "readOutstanding").mockResolvedValue(10n)
    jest
      .spyOn(EthereumSyndicationTool, "readPoolBalanceDepot")
      .mockResolvedValue(10n)
    jest
      .spyOn(EthereumSyndicationTool, "readSyndicatedPrincipal")
      .mockResolvedValue(0n)
    const step = MockShadowBackingSteps.planVerifyCustody(
      actor,
      "verify",
      "verify",
      {},
      ChainKind.EVM
    )
    await expect(step.runner(context, step.input, signal)).rejects.toThrow(
      "principal must equal backing"
    )
  })

  it("refuses a mismatched deployment seed before publishing a funding amount", async () => {
    jest
      .spyOn(WireSyndicationTool, "readOutstanding")
      .mockResolvedValue(110_000_000_000n)
    jest
      .spyOn(EthereumSyndicationTool, "readPoolBalanceDepot")
      .mockResolvedValue(0n)
    jest
      .mocked(EthereumSyndicationTool.readSyndicatedPrincipal)
      .mockResolvedValue(0n)
    const read = MockShadowBackingSteps.planReadCustody(
      actor,
      "read",
      "read",
      {},
      ChainKind.EVM
    )
    await expect(read.runner(context, read.input, signal)).rejects.toThrow(
      "principal must equal planned depot obligation"
    )
    expect(context.outputs.get(MockShadowBackingEthereumRequiredKey)).toBeNull()
  })

  it("refuses an obligation that changes during custody funding", async () => {
    context.outputs.set(MockShadowBackingEthereumPrincipalKey, 10n)
    jest.spyOn(WireSyndicationTool, "readOutstanding").mockResolvedValue(11n)
    jest
      .spyOn(EthereumSyndicationTool, "readPoolBalanceDepot")
      .mockResolvedValue(11n)
    jest
      .mocked(EthereumSyndicationTool.readSyndicatedPrincipal)
      .mockResolvedValue(10n)
    const verify = MockShadowBackingSteps.planVerifyCustody(
      actor,
      "verify",
      "verify",
      {},
      ChainKind.EVM
    )
    await expect(verify.runner(context, verify.input, signal)).rejects.toThrow(
      "obligation changed during backing"
    )
  })

  describe.each([
    [
      "airdrop",
      MockShadowBackingSteps.planAirdropSolana,
      SolanaFundingTool,
      "planKeypairAirdrop",
      "floorLamports",
      MockShadowBackingSteps.SolanaFundingMargin
    ],
    [
      "deposit",
      MockShadowBackingSteps.planDepositSolana,
      SolanaLiqSyndicationTool,
      "planDepositForLiqsol",
      "lamports",
      0n
    ],
    [
      "donate",
      MockShadowBackingSteps.planDonateSolana,
      SolanaLiqSyndicationTool,
      "planDonateToPool",
      "amount",
      0n
    ]
  ] as const)("Solana %s", (_name, plan, tool, runner, amountField, margin) => {
    it("performs exactly one underlying write with the measured amount", async () => {
      const write = jest.fn().mockResolvedValue(undefined),
        original = tool[
          runner as keyof typeof tool
        ] as typeof SolanaFundingTool.planKeypairAirdrop,
        spy = jest.spyOn(tool, runner as never).mockImplementation(((
          ...args: Parameters<typeof original>
        ) => {
          const planned = original(...args)
          return ClusterBuildStep.create(
            planned.actor,
            planned.name,
            planned.description,
            planned.options,
            planned.input,
            write
          )
        }) as never),
        step = plan(actor, "write", "backing", {})
      context.outputs.set(step.input.amountKey, 110_000_000_000n)
      await step.runner(context, step.input, signal)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith(
        context,
        expect.objectContaining({ [amountField]: 110_000_000_000n + margin }),
        signal
      )
    })
    it("skips covered custody and refuses missing amounts or cancellation before writing", async () => {
      const write = jest.fn().mockResolvedValue(undefined),
        original = tool[
          runner as keyof typeof tool
        ] as typeof SolanaFundingTool.planKeypairAirdrop,
        spy = jest.spyOn(tool, runner as never).mockImplementation(((
          ...args: Parameters<typeof original>
        ) => {
          const planned = original(...args)
          return ClusterBuildStep.create(
            planned.actor,
            planned.name,
            planned.description,
            planned.options,
            planned.input,
            write
          )
        }) as never),
        step = plan(actor, "write", "backing", {})
      await expect(step.runner(context, step.input, signal)).rejects.toThrow()
      context.outputs.set(step.input.amountKey, 0n)
      await step.runner(context, step.input, signal)
      await expect(
        step.runner(context, step.input, AbortSignal.abort())
      ).rejects.toThrow()
      expect(spy).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
    })
  })

  describe.each([
    [
      "deposit",
      MockShadowBackingSteps.planDepositEthereum,
      "planDepositLiqEth",
      "amountWei"
    ],
    [
      "donate",
      MockShadowBackingSteps.planDonateEthereum,
      "planDonateToPool",
      "amount"
    ]
  ] as const)("Ethereum %s", (_name, plan, runner, amountField) => {
    it("performs one underlying write in native wei with the backer in its input", async () => {
      const write = jest.fn().mockResolvedValue(undefined),
        original = EthereumSyndicationTool[runner],
        spy = jest
          .spyOn(EthereumSyndicationTool, runner)
          .mockImplementation(
            (
              ...args: Parameters<
                typeof EthereumSyndicationTool.planDepositLiqEth
              >
            ) => {
              const planned = original(...args)
              return ClusterBuildStep.create(
                planned.actor,
                planned.name,
                planned.description,
                planned.options,
                planned.input,
                write
              )
            }
          ),
        step = plan(actor, "write", "backing", {})
      context.outputs.set(step.input.amountKey, 110_000_000_000_000_000_000n)
      await step.runner(context, step.input, signal)
      expect(spy).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledWith(
        context,
        expect.objectContaining({
          walletName: MockShadowBackingSteps.EthereumBackerLabel,
          [amountField]: 110_000_000_000_000_000_000n
        }),
        signal
      )
    })
    it("skips covered custody and refuses missing amounts or cancellation before writing", async () => {
      const write = jest.fn().mockResolvedValue(undefined),
        original = EthereumSyndicationTool[runner],
        spy = jest
          .spyOn(EthereumSyndicationTool, runner)
          .mockImplementation(
            (
              ...args: Parameters<
                typeof EthereumSyndicationTool.planDepositLiqEth
              >
            ) => {
              const planned = original(...args)
              return ClusterBuildStep.create(
                planned.actor,
                planned.name,
                planned.description,
                planned.options,
                planned.input,
                write
              )
            }
          ),
        step = plan(actor, "write", "backing", {})
      await expect(step.runner(context, step.input, signal)).rejects.toThrow()
      context.outputs.set(step.input.amountKey, 0n)
      await step.runner(context, step.input, signal)
      await expect(
        step.runner(context, step.input, AbortSignal.abort())
      ).rejects.toThrow()
      expect(spy).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
    })
  })

  describe("Ethereum fund", () => {
    const RequiredWei = 110_000_000_000_000_000_000n

    /** Double both funding factories: keep their planned inputs, replace their runners. */
    function doubleFunding() {
      const createWrite = jest.fn().mockResolvedValue(undefined),
        fundWrite = jest.fn().mockResolvedValue(undefined),
        originalCreate = EthereumFundingTool.planCreateWallet,
        originalSetBalance = EthereumFundingTool.planSetBalance,
        create = jest
          .spyOn(EthereumFundingTool, "planCreateWallet")
          .mockImplementation(
            (...args: Parameters<typeof EthereumFundingTool.planCreateWallet>) => {
              const planned = originalCreate(...args)
              return ClusterBuildStep.create(
                planned.actor,
                planned.name,
                planned.description,
                planned.options,
                planned.input,
                createWrite
              )
            }
          ),
        fund = jest
          .spyOn(EthereumFundingTool, "planSetBalance")
          .mockImplementation(
            (...args: Parameters<typeof EthereumFundingTool.planSetBalance>) => {
              const planned = originalSetBalance(...args)
              return ClusterBuildStep.create(
                planned.actor,
                planned.name,
                planned.description,
                planned.options,
                planned.input,
                fundWrite
              )
            }
          )
      return { create, createWrite, fund, fundWrite }
    }

    it("plans the backer's handle with the measured-amount key and its named runner", () => {
      const step = MockShadowBackingSteps.planFundEthereum(actor, "fund", "backing", {})
      expect(step.input).toEqual({
        kind: "MockShadowBackingSteps.EthereumBackingInput",
        amountKey: MockShadowBackingEthereumRequiredKey,
        walletName: MockShadowBackingSteps.EthereumBackerLabel
      })
      expect(step.runner).toBe(MockShadowBackingSteps.runFundEthereum)
    })

    it("creates the backer wallet once, then performs ONE set-balance of the amount plus the gas margin", async () => {
      const { create, createWrite, fund, fundWrite } = doubleFunding(),
        step = MockShadowBackingSteps.planFundEthereum(actor, "fund", "backing", {})
      context.outputs.set(step.input.amountKey, RequiredWei)
      await step.runner(context, step.input, signal)
      expect(create).toHaveBeenCalledTimes(1)
      expect(createWrite).toHaveBeenCalledTimes(1)
      expect(createWrite).toHaveBeenCalledWith(
        context,
        expect.objectContaining({
          kind: "EthereumFundingTool.CreateWalletInput",
          walletName: MockShadowBackingSteps.EthereumBackerLabel
        }),
        signal
      )
      expect(fund).toHaveBeenCalledTimes(1)
      expect(fundWrite).toHaveBeenCalledTimes(1)
      expect(fundWrite).toHaveBeenCalledWith(
        context,
        expect.objectContaining({
          kind: "EthereumFundingTool.SetBalanceInput",
          walletName: MockShadowBackingSteps.EthereumBackerLabel,
          balanceWei: RequiredWei + MockShadowBackingSteps.EthereumFundingMargin
        }),
        signal
      )
      // The wallet is created BEFORE it is funded.
      expect(createWrite.mock.invocationCallOrder[0]).toBeLessThan(
        fundWrite.mock.invocationCallOrder[0]
      )
    })

    it("skips covered custody and refuses missing amounts or cancellation before creating or funding", async () => {
      const { create, createWrite, fund, fundWrite } = doubleFunding(),
        step = MockShadowBackingSteps.planFundEthereum(actor, "fund", "backing", {})
      await expect(step.runner(context, step.input, signal)).rejects.toThrow()
      context.outputs.set(step.input.amountKey, 0n)
      await step.runner(context, step.input, signal)
      await expect(
        step.runner(context, step.input, AbortSignal.abort())
      ).rejects.toThrow()
      expect(create).not.toHaveBeenCalled()
      expect(createWrite).not.toHaveBeenCalled()
      expect(fund).not.toHaveBeenCalled()
      expect(fundWrite).not.toHaveBeenCalled()
    })
  })
})
