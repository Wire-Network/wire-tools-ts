import { ethers } from "ethers"
import { Constants } from "@wireio/cluster-tool"
import {
  BatchOperatorUnderwritingSteps,
  SyndicationScenario
} from "@wireio/cluster-tool/flow"
import {
  ClusterBuild,
  type ClusterBuildPhase
} from "@wireio/cluster-tool/orchestration"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureContext } from "../../config/clusterBuildContextFixture.js"

const Steps = BatchOperatorUnderwritingSteps
/** Two LIQETH in depot units. */
const Amount = 2_000_000_000n
/** The user whose syndication the operators underwrite. */
const Syndicator: BatchOperatorUnderwritingSteps.EthereumSyndicator = {
  account: "synd.ethuser",
  walletName: "ethereum-user",
  amount: Amount
}

describe("BatchOperatorUnderwritingSteps Ethereum syndication", () => {
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
      amount: Steps.ethereumNativeAmount(Amount)
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
})
