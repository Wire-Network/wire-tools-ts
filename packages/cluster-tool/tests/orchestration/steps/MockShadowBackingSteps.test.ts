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
import { EthereumSyndicationTool } from "@wireio/cluster-tool/tools/ethereum"
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
      MockShadowBackingSteps.runDepositEthereum,
      MockShadowBackingSteps.runDonateEthereum,
      MockShadowBackingSteps.runInitializeEthereum,
      MockShadowBackingSteps.runVerifyCustody
    ])
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
      jest.spyOn(WireSyndicationTool, "readOutstanding").mockResolvedValue(backing)
      jest.spyOn(SolanaLiqSyndicationTool, "readPoolBalance").mockResolvedValue(custody)
      jest.spyOn(EthereumSyndicationTool, "readPoolBalanceDepot").mockResolvedValue(custody)
      const step = MockShadowBackingSteps.planReadCustody(actor, "read", "read", {}, chain)
      await step.runner(context, step.input, signal)
      const nativeRequired = context.outputs.assert(solana
        ? MockShadowBackingSolanaRequiredKey
        : MockShadowBackingEthereumRequiredKey),
        scale = solana ? 1n : MockShadowBackingSteps.EthereumWeiPerDepotUnit
      expect(nativeRequired).toBe(shortfall * scale)
      expect(custody + nativeRequired / scale).toBe(backing)
      if (!solana) {
        expect(context.outputs.assert(MockShadowBackingEthereumPrincipalKey)).toBe(backing)
      }
    }
  )

  it.each([ChainKind.SVM, ChainKind.EVM] as const)(
    "does not acquire backing when custody already covers %s",
    async chain => {
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
      jest.spyOn(EthereumSyndicationTool, "readSyndicatedPrincipal").mockResolvedValue(10n)
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
    jest.spyOn(EthereumSyndicationTool, "readPoolBalanceDepot").mockResolvedValue(10n)
    jest.spyOn(EthereumSyndicationTool, "readSyndicatedPrincipal").mockResolvedValue(0n)
    const step = MockShadowBackingSteps.planVerifyCustody(actor, "verify", "verify", {}, ChainKind.EVM)
    await expect(step.runner(context, step.input, signal)).rejects.toThrow("principal must equal backing")
  })

  it("seeds depot principal even when custody already covers the obligation", async () => {
    jest.spyOn(WireSyndicationTool, "readOutstanding").mockResolvedValue(110_000_000_000n)
    jest.spyOn(EthereumSyndicationTool, "readPoolBalanceDepot").mockResolvedValue(110_000_000_000n)
    const read = MockShadowBackingSteps.planReadCustody(actor, "read", "read", {}, ChainKind.EVM)
    await read.runner(context, read.input, signal)
    expect(context.outputs.assert(MockShadowBackingEthereumRequiredKey)).toBe(0n)
    const write = jest.fn().mockResolvedValue(undefined),
      original = EthereumSyndicationTool.planInitializeSyndication,
      spy = jest.spyOn(EthereumSyndicationTool, "planInitializeSyndication").mockImplementation((...args: Parameters<typeof original>) => {
        const planned = original(...args)
        return ClusterBuildStep.create(planned.actor, planned.name, planned.description, planned.options, planned.input, write)
      }),
      step = MockShadowBackingSteps.planInitializeEthereum(actor, "initialize", "initialize", {})
    await step.runner(context, step.input, signal)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(context, expect.objectContaining({
      ethereumHdIndex: MockShadowBackingSteps.EthereumBackerHdIndex,
      initialPrincipal: 110_000_000_000n
    }), signal)
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
          ethereumHdIndex: MockShadowBackingSteps.EthereumBackerHdIndex,
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
})
