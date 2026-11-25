import { ethers } from "ethers"
import { SysioContracts } from "@wireio/sdk-core"
import { Constants } from "@wireio/cluster-tool"
import {
  BatchOperatorUnderwritingSteps,
  SyndicationScenario
} from "@wireio/cluster-tool/flow"
import {
  ClusterBuild,
  outputKey,
  type ClusterBuildPhase
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { WireSyndicationTool } from "@wireio/cluster-tool/tools/wire"

import { fixtureContext } from "../../config/clusterBuildContextFixture.js"
import { syndEnvelopeRow } from "../../tools/wire/syndicationRowFixture.js"

const Steps = BatchOperatorUnderwritingSteps
/** Two LIQETH in depot units. */
const Amount = 2_000_000_000n
const CreditedAmount = outputKey<bigint>(
  "ethereumTest.creditedAmount",
  "depot credit"
)
/** The user whose syndication the operators underwrite. */
const Syndicator: BatchOperatorUnderwritingSteps.EthereumSyndicator = {
  account: "synd.ethuser",
  walletName: "ethereum-user",
  amount: Amount,
  creditedAmount: CreditedAmount
}

describe("BatchOperatorUnderwritingSteps Ethereum syndication", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("converts a depot LIQETH amount to native liqETH precision — nine more decimals", () => {
    expect(Steps.ethereumNativeAmount(Amount)).toBe(Amount * 1_000_000_000n)
    expect(Steps.ethereumNativeAmount(1n)).toBe(1_000_000_000n)
  })

  it("deposits with headroom and funds the wallet for the deposit plus one ether of gas", () => {
    expect(Steps.EthereumDepositHeadroomFactor).toBe(2n)
    expect(Steps.EthereumGasHeadroomWei).toBe(ethers.WeiPerEther)
    expect(Steps.ethereumDepositWei(Amount)).toBe(
      Steps.ethereumNativeAmount(Amount) * 2n
    )
    expect(Steps.ethereumWalletBalanceWei(Amount)).toBe(
      Steps.ethereumDepositWei(Amount) + ethers.WeiPerEther
    )
    expect(Steps.ethereumWalletBalanceWei(Amount)).toBeGreaterThan(
      Steps.ethereumDepositWei(Amount)
    )
  })

  it("plans the user's account, wallet, funding, link, deposit, approval and syndication, one write each", () => {
    const cluster = ClusterBuild.forContext(fixtureContext()),
      phase = Steps.planEthereumSyndication(
        cluster,
        "EthereumSyndication",
        "the user syndicates",
        Syndicator
      )
    expect(cluster.children).toEqual([phase])
    expect(phase.name).toBe("EthereumSyndication")
    expect(phase.steps.map(step => step.name)).toEqual([
      "create-ethereum-user",
      "create-ethereum-wallet",
      "fund-ethereum-wallet",
      "link-ethereum-user",
      "ethereum-deposit",
      "ethereum-approve",
      "ethereum-syndicate"
    ])
    expect(phase.steps.map(step => step.input.kind)).toEqual([
      "AccountSteps.CreateKeyedInput",
      "EthereumFundingTool.CreateWalletInput",
      "EthereumFundingTool.SetBalanceInput",
      "SyndicationUserSteps.LinkEthereumKeyInput",
      "EthereumSyndicationTool.DepositLiqEthInput",
      "EthereumSyndicationTool.ApproveLiqEthInput",
      "EthereumSyndicationTool.SyndicateInput"
    ])
    phase.steps.forEach(step => expect(step.actor).toBe(Report.Actor.User))
    const [account, wallet, fund, link, deposit, approve, syndicate] = phase.steps
    expect(account.input).toMatchObject({
      account: Syndicator.account,
      publicKey: Constants.DEV_K1_PUBLIC_KEY
    })
    expect(wallet.input).toMatchObject({ walletName: Syndicator.walletName })
    expect(fund.input).toMatchObject({
      walletName: Syndicator.walletName,
      balanceWei: Steps.ethereumWalletBalanceWei(Amount)
    })
    expect(link.input).toMatchObject({
      account: Syndicator.account,
      walletName: Syndicator.walletName
    })
    expect(deposit.input).toMatchObject({
      walletName: Syndicator.walletName,
      amountWei: Steps.ethereumDepositWei(Amount)
    })
    expect(approve.input).toMatchObject({
      walletName: Syndicator.walletName,
      amount: Steps.ethereumNativeAmount(Amount)
    })
    expect(syndicate.input).toMatchObject({
      walletName: Syndicator.walletName,
      amount: Steps.ethereumNativeAmount(Amount),
      creditedAmount: CreditedAmount
    })
    expect(syndicate.input).not.toHaveProperty("compressedPubkey")
  })

  it("budgets depot writes at irreversibility and outpost writes at the outpost budget", () => {
    const phase = Steps.planEthereumSyndication(
        ClusterBuild.forContext(fixtureContext()),
        "EthereumSyndication",
        "the user syndicates",
        Syndicator
      ) as ClusterBuildPhase,
      budgets = new Map(phase.steps.map(step => [step.name, step.options]))
    expect(budgets.get("create-ethereum-user")).toBe(SyndicationScenario.WriteOptions)
    expect(budgets.get("link-ethereum-user")).toBe(SyndicationScenario.WriteOptions)
    expect(budgets.get("fund-ethereum-wallet")).toBe(SyndicationScenario.OutpostOptions)
    expect(budgets.get("ethereum-syndicate")).toBe(SyndicationScenario.OutpostOptions)
  })

  it.each([Amount - 1n, Amount])(
    "records a request matching the actual credit of %s depot units",
    async amount => {
      const ctx = fixtureContext(),
        plan = Steps.createPlan("ethereumTest"),
        chain = Constants.ETHEREUM_CHAIN_CODENAME,
        token = Constants.liqTokenCode(chain),
        { REQUESTED } = SysioContracts.SysioSyndEnvelopeState,
        matching = {
          ...syndEnvelopeRow(chain, token, 2, REQUESTED, 2),
          synd_total: amount.toString()
        },
        wrongAmount = {
          ...syndEnvelopeRow(chain, token, 1, REQUESTED, 1),
          synd_total: (amount + 1n).toString()
        },
        step = Steps.planVerifyRecorded(
          Report.Actor.Sysio,
          "ethereum-requested",
          "record the issued request",
          {},
          CreditedAmount,
          null,
          plan.firstEpoch,
          plan.firstRequest,
          chain,
          token
        )
      ctx.outputs.set(CreditedAmount, amount)
      const readEnvelopes = jest
        .spyOn(WireSyndicationTool, "readEnvelopes")
        .mockResolvedValue([wrongAmount, matching])
      await step.runner(ctx, step.input, new AbortController().signal)
      expect(readEnvelopes).toHaveBeenCalledWith(ctx, chain, token)
      expect(ctx.outputs.assert(plan.firstEpoch)).toBe(matching.epoch_index)
      expect(ctx.outputs.assert(plan.firstRequest)).toBe(matching.request_id)
    }
  )
})
