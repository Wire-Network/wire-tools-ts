import { ethers } from "ethers"
import { ClusterBuild, ClusterBuildContext } from "@wireio/cluster-tool/orchestration"
import { EthereumPreLaunchSteps } from "@wireio/cluster-tool/orchestration/ethereum"
import { EthereumSyndicationTool } from "@wireio/cluster-tool/tools/ethereum"
import { AnvilProcess } from "@wireio/cluster-tool/cluster/processes"
import { getLogger } from "@wireio/cluster-tool/logging"
import { Report } from "@wireio/cluster-tool/report"
import { fixtureConfig } from "../../config/clusterConfigFixture.js"

/** Writes per actor: fund, deposit, approve, stake-or-purchase. */
const WritesPerActor = 4
/** The owner's closing writes: the two role grants, the reward, the sync, the drift. */
const ClosingWrites = 5

describe("EthereumPreLaunchSteps", () => {
  let context: ClusterBuildContext
  beforeEach(() => {
    context = new ClusterBuildContext(fixtureConfig(), getLogger("pre-launch-test"))
  })

  it("places the actors past the funded anvil set and the mock bonder's slot", () => {
    expect(EthereumPreLaunchSteps.ActorEthereumHdIndexBase).toBe(AnvilProcess.AccountCount + 1)
    expect(EthereumPreLaunchSteps.actorEthereumHdIndex(0)).toBe(AnvilProcess.AccountCount + 1)
    expect(EthereumPreLaunchSteps.actorEthereumHdIndex(4)).toBe(AnvilProcess.AccountCount + 5)
  })

  it("derives the access-manager role id as wire-ethereum's getRoleId does: the first 8 bytes of keccak256(name)", () => {
    const id = EthereumPreLaunchSteps.roleId(EthereumPreLaunchSteps.YieldOperatorRole)
    expect(id).toMatch(/^0x[0-9a-f]{16}$/)
    expect(id).toBe(ethers.keccak256(ethers.toUtf8Bytes("yield_operator")).slice(0, 18))
    expect(EthereumPreLaunchSteps.roleId(EthereumPreLaunchSteps.IndexShiftRole)).toBe(
      ethers.keccak256(ethers.toUtf8Bytes("index_shift")).slice(0, 18)
    )
  })

  it("composes one Step per write, actor by actor, then the owner's closing writes", () => {
    const phase = EthereumPreLaunchSteps.planPreLaunch(
        ClusterBuild.forContext(context),
        "pre-launch",
        "pre-launch",
        {}
      ),
      runners = phase.steps.map(step => step.runner),
      perActor = [
        EthereumPreLaunchSteps.runFund,
        EthereumSyndicationTool.runDepositLiqEth,
        EthereumPreLaunchSteps.runApproveDepositor
      ]
    expect(phase.steps).toHaveLength(
      (EthereumPreLaunchSteps.StakerCount + EthereumPreLaunchSteps.BuyerCount) * WritesPerActor +
        ClosingWrites
    )
    for (let index = 0; index < EthereumPreLaunchSteps.StakerCount; index++) {
      expect(runners.slice(index * WritesPerActor, index * WritesPerActor + WritesPerActor)).toEqual([
        ...perActor,
        EthereumPreLaunchSteps.runStake
      ])
    }
    const buyersStart = EthereumPreLaunchSteps.StakerCount * WritesPerActor
    for (let index = 0; index < EthereumPreLaunchSteps.BuyerCount; index++) {
      const start = buyersStart + index * WritesPerActor
      expect(runners.slice(start, start + WritesPerActor)).toEqual([
        ...perActor,
        EthereumPreLaunchSteps.runPurchasePretokens
      ])
    }
    expect(runners.slice(-ClosingWrites)).toEqual([
      EthereumPreLaunchSteps.runGrantYieldOperator,
      EthereumPreLaunchSteps.runGrantIndexShift,
      EthereumPreLaunchSteps.runIncreaseIndex,
      EthereumPreLaunchSteps.runHarvestMeasuredYield,
      EthereumPreLaunchSteps.runIncreaseIndex
    ])
  })

  it("gives every actor its own HD index and the amounts the exercise names", () => {
    const phase = EthereumPreLaunchSteps.planPreLaunch(
        ClusterBuild.forContext(context),
        "pre-launch",
        "pre-launch",
        {}
      ),
      stakes = phase.steps.filter(step => step.runner === EthereumPreLaunchSteps.runStake),
      purchases = phase.steps.filter(step => step.runner === EthereumPreLaunchSteps.runPurchasePretokens),
      indices = [...stakes, ...purchases].map(
        step => (step.input as EthereumPreLaunchSteps.ActorAmountInput).ethereumHdIndex
      )
    expect(new Set(indices).size).toBe(indices.length)
    indices.forEach(index => expect(index).toBeGreaterThanOrEqual(EthereumPreLaunchSteps.ActorEthereumHdIndexBase))
    stakes.forEach(step =>
      expect((step.input as EthereumPreLaunchSteps.ActorAmountInput).amountWei).toBe(EthereumPreLaunchSteps.StakeWei)
    )
    purchases.forEach(step =>
      expect((step.input as EthereumPreLaunchSteps.ActorAmountInput).amountWei).toBe(EthereumPreLaunchSteps.PretokenSpendWei)
    )
    const rewards = phase.steps
      .filter(step => step.runner === EthereumPreLaunchSteps.runIncreaseIndex)
      .map(step => (step.input as EthereumPreLaunchSteps.IndexRewardInput).rewardWei)
    expect(rewards).toEqual([EthereumPreLaunchSteps.YieldRewardWei, EthereumPreLaunchSteps.UnsyncedDriftWei])
    expect(phase.steps.map(step => step.actor)).toContain(Report.Actor.User)
  })
})
