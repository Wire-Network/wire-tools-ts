import { ethers } from "ethers"
import { range } from "lodash"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import { Report } from "../../report/Report.js"
import { EthereumSyndicationTool } from "../../tools/ethereum/EthereumSyndicationTool.js"
import { loadOutpostContract } from "../../utils/ethereumUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import { ClusterBuildPhase } from "../ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../ClusterBuildPhaseBase.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"
import { EthereumOutpostBootstrapper } from "./EthereumOutpostBootstrapper.js"

/**
 * The pre-launch outpost used as its users used it, between the ladder and
 * the freeze: liqETH minted through the DepositManager, staked on the
 * Depositor by the stakers and spent on pretokens by the buyers, yield into
 * the index, the last sync that books `lastPoolLiqBalance`, then index drift
 * the booked figure must NOT follow. Every write is its own Step, one actor
 * per Step; the OPP assertions those writes emit are what the capital-index
 * snapshot replays into the depot's import.
 *
 * The actors are anvil HD accounts past the funded set (the mock bonder sits
 * at `AnvilProcess.AccountCount`; the actors follow), funded by the deploy
 * owner first — so no operator, panic or bonder slot is ever reused.
 */
export namespace EthereumPreLaunchSteps {
  /** How many actors stake liqETH. */
  export const StakerCount = 3
  /** How many actors buy pretokens with liqETH. */
  export const BuyerCount = 2
  /** The first actor's HD index: past the funded anvil set AND the mock bonder's slot. */
  export const ActorEthereumHdIndexBase = AnvilProcess.AccountCount + 1
  /** ETH the owner funds each actor with (gas plus the deposit). */
  export const ActorFundingWei = ethers.parseEther("30")
  /** ETH each actor deposits for liqETH (`DepositManager.deposit` minimum is 0.01). */
  export const UserDepositWei = ethers.parseEther("20")
  /** liqETH each staker stakes. */
  export const StakeWei = ethers.parseEther("5")
  /** liqETH each buyer spends on pretokens. */
  export const PretokenSpendWei = ethers.parseEther("2")
  /** The index reward credited before the last sync (`LiqEthToken.increaseIndex`). */
  export const YieldRewardWei = ethers.parseEther("0.5")
  /** The index reward credited AFTER the last sync: the booked figure must not follow it. */
  export const UnsyncedDriftWei = ethers.parseEther("0.25")
  /** The outpost role `harvestMeasuredYield` needs, as `permissions/outpost.yaml` names it. */
  export const YieldOperatorRole = "yield_operator"
  /** The liqEth role `LiqEthToken.increaseIndex` needs, as `permissions/liqeth.yaml` names it. */
  export const IndexShiftRole = "index_shift"
  /** A role grant with no execution delay (`AccessManager.grantRole`'s third argument). */
  export const NoExecutionDelay = 0
  /** The liqEth access manager's book key and artifact. */
  export const LiqEthAuthorityContractName = "LiqEthAuthority"
  export const LiqEthAuthorityArtifactSubpath = ["liqEth"] as const
  /** The Depositor proxy's book key and its V3 artifact (as deployed on mainnet). */
  export const DepositorContractName = "Depositor"
  export const DepositorArtifactSubpath = ["outpost", "v3"] as const
  export const DepositorArtifactName = "DepositorV3Deployed"

  /** The Depositor reads the exercise and its verifies make. */
  export interface DepositorView {
    lastPoolLiqBalance(): Promise<bigint>
    totalShares(): Promise<bigint>
    index(): Promise<bigint>
  }

  /** `Depositor` entry points the exercise encodes. */
  export enum DepositorFunction {
    stakeLiqETH = "stakeLiqETH",
    purchasePretokensWithLiqETH = "purchasePretokensWithLiqETH",
    harvestMeasuredYield = "harvestMeasuredYield"
  }

  /** `LiqEthToken` entry points the exercise encodes. */
  export enum LiqEthTokenFunction {
    approve = "approve",
    increaseIndex = "increaseIndex"
  }

  /** `OutpostManager` entry points the exercise encodes. */
  export enum OutpostManagerFunction {
    grantRole = "grantRole"
  }

  /** `LiqEthAuthority` (an OpenZeppelin AccessManager) entry points the exercise encodes. */
  export enum AccessManagerFunction {
    grantRole = "grantRole"
  }

  /** One actor's write: who (HD index) and how much (wei). */
  export interface ActorAmountInput extends StepInput {
    readonly kind: "EthereumPreLaunchSteps.ActorAmountInput"
    readonly ethereumHdIndex: number
    readonly amountWei: bigint
  }

  /** The owner's index reward (`increaseIndex`), in wei. */
  export interface IndexRewardInput extends StepInput {
    readonly kind: "EthereumPreLaunchSteps.IndexRewardInput"
    readonly rewardWei: bigint
  }

  /** The HD index of the `index`-th actor. */
  export function actorEthereumHdIndex(index: number): number {
    return ActorEthereumHdIndexBase + index
  }

  /** The 8-byte access-manager role id of `roleName`, as wire-ethereum's `getRoleId` derives it. */
  export function roleId(roleName: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(roleName)).slice(0, 18)
  }

  /**
   * Compose the exercise: per staker — fund, deposit, approve, stake; per
   * buyer — fund, deposit, approve, purchase; then the yield operator grant,
   * the index reward, the last sync, and the unsynced drift.
   */
  export function planPreLaunch<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildPhase<C> {
    const stakers = range(StakerCount).flatMap(index => {
        const hdIndex = actorEthereumHdIndex(index),
          label = `staker-${index}`
        return [
          planFund<C>(Report.Actor.EthereumOutpost, `fund-${label}`, "the owner funds the staker with ETH", options, hdIndex),
          EthereumSyndicationTool.planDepositLiqEth<C>(Report.Actor.User, `deposit-liqeth-${label}`, "the staker mints liqETH through the DepositManager", options, hdIndex, UserDepositWei),
          planApproveDepositor<C>(Report.Actor.User, `approve-depositor-${label}`, "the staker approves the Depositor for the stake", options, hdIndex, StakeWei),
          planStake<C>(Report.Actor.User, `stake-${label}`, "the staker stakes liqETH on the Depositor", options, hdIndex, StakeWei)
        ]
      }),
      buyers = range(BuyerCount).flatMap(index => {
        const hdIndex = actorEthereumHdIndex(StakerCount + index),
          label = `buyer-${index}`
        return [
          planFund<C>(Report.Actor.EthereumOutpost, `fund-${label}`, "the owner funds the buyer with ETH", options, hdIndex),
          EthereumSyndicationTool.planDepositLiqEth<C>(Report.Actor.User, `deposit-liqeth-${label}`, "the buyer mints liqETH through the DepositManager", options, hdIndex, UserDepositWei),
          planApproveDepositor<C>(Report.Actor.User, `approve-depositor-${label}`, "the buyer approves the Depositor for the purchase", options, hdIndex, PretokenSpendWei),
          planPurchasePretokens<C>(Report.Actor.User, `purchase-pretokens-${label}`, "the buyer spends liqETH on pretokens", options, hdIndex, PretokenSpendWei)
        ]
      })
    return ClusterBuildPhase.create<C>(parent, name, description, [
      ...stakers,
      ...buyers,
      planGrantYieldOperator<C>(Report.Actor.EthereumOutpost, "grant-yield-operator", "the owner takes the yield operator role", options),
      planGrantIndexShift<C>(Report.Actor.EthereumOutpost, "grant-index-shift", "the owner takes liqEth's index_shift role", options),
      planIncreaseIndex<C>(Report.Actor.EthereumOutpost, "credit-index-reward", "liqETH credits a reward to the index", options, YieldRewardWei),
      planHarvestMeasuredYield<C>(Report.Actor.EthereumOutpost, "harvest-measured-yield", "the last sync books the pool balance as lastPoolLiqBalance", options),
      planIncreaseIndex<C>(Report.Actor.EthereumOutpost, "credit-unsynced-drift", "the index moves after the last sync; the booked figure must not follow", options, UnsyncedDriftWei)
    ])
  }

  /** Plan the owner funding one actor with ETH. */
  export function planFund<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number
  ): ClusterBuildStep<C, ActorAmountInput> {
    return ClusterBuildStep.create<C, ActorAmountInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumPreLaunchSteps.ActorAmountInput", ethereumHdIndex, amountWei: ActorFundingWei },
      runFund
    )
  }

  /** Named runner — ONE value transfer from the deploy owner to the actor. */
  export async function runFund<C extends ClusterBuildContext>(
    ctx: C,
    input: ActorAmountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const owner = ownerWallet(ctx),
      actor = EthereumSyndicationTool.hdWallet(ctx, input.ethereumHdIndex)
    await EthereumSyndicationTool.sendTransaction(
      owner,
      { to: actor.address, value: input.amountWei },
      "EthereumPreLaunchSteps.planFund"
    )
  }

  /** Plan one `LiqEthToken.approve(Depositor, amount)` by the actor. */
  export function planApproveDepositor<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number,
    amountWei: bigint
  ): ClusterBuildStep<C, ActorAmountInput> {
    return ClusterBuildStep.create<C, ActorAmountInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumPreLaunchSteps.ActorAmountInput", ethereumHdIndex, amountWei },
      runApproveDepositor
    )
  }

  /** Named runner — ONE `approve`, signed by the actor. */
  export async function runApproveDepositor<C extends ClusterBuildContext>(
    ctx: C,
    input: ActorAmountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const holder = EthereumSyndicationTool.hdWallet(ctx, input.ethereumHdIndex),
      liqEth = EthereumSyndicationTool.loadLiqEthToken(ctx, holder),
      depositor = loadDepositor(ctx, holder)
    await EthereumSyndicationTool.sendTransaction(
      holder,
      {
        to: liqEth.target,
        data: liqEth.interface.encodeFunctionData(LiqEthTokenFunction.approve, [
          depositor.target,
          input.amountWei
        ])
      },
      "EthereumPreLaunchSteps.planApproveDepositor"
    )
  }

  /** Plan one `Depositor.stakeLiqETH(amount)` by the staker. */
  export function planStake<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number,
    amountWei: bigint
  ): ClusterBuildStep<C, ActorAmountInput> {
    return ClusterBuildStep.create<C, ActorAmountInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumPreLaunchSteps.ActorAmountInput", ethereumHdIndex, amountWei },
      runStake
    )
  }

  /** Named runner — ONE `stakeLiqETH`, signed by the staker. */
  export async function runStake<C extends ClusterBuildContext>(
    ctx: C,
    input: ActorAmountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const staker = EthereumSyndicationTool.hdWallet(ctx, input.ethereumHdIndex),
      depositor = loadDepositor(ctx, staker)
    await EthereumSyndicationTool.sendTransaction(
      staker,
      {
        to: depositor.target,
        data: depositor.interface.encodeFunctionData(DepositorFunction.stakeLiqETH, [
          input.amountWei
        ])
      },
      "EthereumPreLaunchSteps.planStake"
    )
  }

  /** Plan one `Depositor.purchasePretokensWithLiqETH(amount, buyer)` by the buyer. */
  export function planPurchasePretokens<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    ethereumHdIndex: number,
    amountWei: bigint
  ): ClusterBuildStep<C, ActorAmountInput> {
    return ClusterBuildStep.create<C, ActorAmountInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumPreLaunchSteps.ActorAmountInput", ethereumHdIndex, amountWei },
      runPurchasePretokens
    )
  }

  /** Named runner — ONE `purchasePretokensWithLiqETH`, signed by the buyer, to the buyer. */
  export async function runPurchasePretokens<C extends ClusterBuildContext>(
    ctx: C,
    input: ActorAmountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const buyer = EthereumSyndicationTool.hdWallet(ctx, input.ethereumHdIndex),
      depositor = loadDepositor(ctx, buyer)
    await EthereumSyndicationTool.sendTransaction(
      buyer,
      {
        to: depositor.target,
        data: depositor.interface.encodeFunctionData(
          DepositorFunction.purchasePretokensWithLiqETH,
          [input.amountWei, buyer.address]
        )
      },
      "EthereumPreLaunchSteps.planPurchasePretokens"
    )
  }

  /** Plan the owner granting itself the yield operator role on the OutpostManager. */
  export function planGrantYieldOperator<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runGrantYieldOperator)
  }

  /** Named runner — ONE `OutpostManager.grantRole(yield_operator, owner)`. */
  export async function runGrantYieldOperator<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const owner = ownerWallet(ctx),
      manager = loadOutpostManager(ctx, owner)
    await EthereumSyndicationTool.sendTransaction(
      owner,
      {
        to: manager.target,
        data: manager.interface.encodeFunctionData(OutpostManagerFunction.grantRole, [
          roleId(YieldOperatorRole),
          owner.address
        ])
      },
      "EthereumPreLaunchSteps.planGrantYieldOperator"
    )
  }

  /** Plan the owner granting itself liqEth's `index_shift` role on the LiqEthAuthority, with no delay. */
  export function planGrantIndexShift<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runGrantIndexShift)
  }

  /** Named runner — ONE `LiqEthAuthority.grantRole(index_shift, owner, 0)`. */
  export async function runGrantIndexShift<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const owner = ownerWallet(ctx),
      authority = loadLiqEthAuthority(ctx, owner)
    await EthereumSyndicationTool.sendTransaction(
      owner,
      {
        to: authority.target,
        data: authority.interface.encodeFunctionData(AccessManagerFunction.grantRole, [
          roleId(IndexShiftRole),
          owner.address,
          NoExecutionDelay
        ])
      },
      "EthereumPreLaunchSteps.planGrantIndexShift"
    )
  }

  /** Plan one `LiqEthToken.increaseIndex(reward)` by the owner, who holds `index_shift` by then. */
  export function planIncreaseIndex<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    rewardWei: bigint
  ): ClusterBuildStep<C, IndexRewardInput> {
    return ClusterBuildStep.create<C, IndexRewardInput>(
      actor,
      name,
      description,
      options,
      { kind: "EthereumPreLaunchSteps.IndexRewardInput", rewardWei },
      runIncreaseIndex
    )
  }

  /** Named runner — ONE `increaseIndex`, signed by the owner. */
  export async function runIncreaseIndex<C extends ClusterBuildContext>(
    ctx: C,
    input: IndexRewardInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const owner = ownerWallet(ctx),
      liqEth = EthereumSyndicationTool.loadLiqEthToken(ctx, owner)
    await EthereumSyndicationTool.sendTransaction(
      owner,
      {
        to: liqEth.target,
        data: liqEth.interface.encodeFunctionData(LiqEthTokenFunction.increaseIndex, [
          input.rewardWei
        ])
      },
      "EthereumPreLaunchSteps.planIncreaseIndex"
    )
  }

  /** Plan the last sync — `Depositor.harvestMeasuredYield()` by the owner (yield operator). */
  export function planHarvestMeasuredYield<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runHarvestMeasuredYield)
  }

  /** Named runner — ONE `harvestMeasuredYield`, signed by the owner. */
  export async function runHarvestMeasuredYield<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const owner = ownerWallet(ctx),
      depositor = loadDepositor(ctx, owner)
    await EthereumSyndicationTool.sendTransaction(
      owner,
      {
        to: depositor.target,
        data: depositor.interface.encodeFunctionData(DepositorFunction.harvestMeasuredYield, [])
      },
      "EthereumPreLaunchSteps.planHarvestMeasuredYield"
    )
  }

  /** The pre-launch Depositor proxy, bound to `runner`, with the V3 ABI it runs at the last rung. */
  export function loadDepositor<C extends ClusterBuildContext>(
    ctx: C,
    runner: ethers.ContractRunner
  ): DepositorView & ethers.BaseContract {
    return loadOutpostContract<DepositorView>(
      ctx.config.ethereumPath,
      EthereumSyndicationTool.readDeployAddresses(ctx, EthereumOutpostBootstrapper.OutpostAddressesFile),
      DepositorContractName,
      [...DepositorArtifactSubpath],
      runner,
      DepositorContractName,
      DepositorArtifactName
    )
  }

  /** The OutpostManager proxy, bound to `runner`, with the V2 ABI it runs at the last rung. */
  export function loadOutpostManager<C extends ClusterBuildContext>(
    ctx: C,
    runner: ethers.ContractRunner
  ): ethers.BaseContract {
    return loadOutpostContract<object>(
      ctx.config.ethereumPath,
      EthereumSyndicationTool.readDeployAddresses(ctx, EthereumOutpostBootstrapper.OutpostAddressesFile),
      EthereumOutpostBootstrapper.OutpostManagerContractName,
      [...EthereumOutpostBootstrapper.OutpostArtifactSubpath],
      runner,
      EthereumOutpostBootstrapper.OutpostManagerContractName,
      EthereumOutpostBootstrapper.OutpostManagerArtifactName
    )
  }

  /** The liqEth access manager, bound to `runner`. */
  export function loadLiqEthAuthority<C extends ClusterBuildContext>(
    ctx: C,
    runner: ethers.ContractRunner
  ): ethers.BaseContract {
    return loadOutpostContract<object>(
      ctx.config.ethereumPath,
      EthereumSyndicationTool.readDeployAddresses(ctx, EthereumOutpostBootstrapper.LiqEthAddressesFile),
      LiqEthAuthorityContractName,
      [...LiqEthAuthorityArtifactSubpath],
      runner
    )
  }

  /** The deploy owner's wallet (anvil HD index 0), connected to the run anvil. */
  function ownerWallet<C extends ClusterBuildContext>(ctx: C): ethers.HDNodeWallet {
    return EthereumSyndicationTool.hdWallet(ctx, EthereumOutpostBootstrapper.DeployerAccountIndex)
  }
}
