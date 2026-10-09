import Assert from "node:assert"
import { Asset, PrivateKey, SysioContracts } from "@wireio/sdk-core"
import { ChainKind } from "@wireio/opp-typescript-models"
import { Wallet } from "ethers"
import {
  AuthExLinkTool,
  ClusterBuildStep,
  Steps,
  WireClient,
  WireCollateralTool,
  verifyStep,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type Report,
  type StepInput
} from "@wireio/cluster-tool"
import { ProducerRegistrationScenarioConstants as Constants } from "./ProducerRegistrationScenarioConstants.js"

/** Runtime writes and reads for custody-backed producer shadow collateral. */
export namespace ProducerCollateralSteps {
  export interface FundingInput extends StepInput {
    readonly kind: "ProducerCollateralSteps.FundingInput"
    readonly token: Constants.CollateralToken
  }
  export interface LinkInput extends StepInput {
    readonly kind: "ProducerCollateralSteps.LinkInput"
  }

  /** Deliver the imported Ethereum shadow to the same fixture account as LIQSOL. */
  export function planLinkEthereum(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ) {
    return ClusterBuildStep.create<ClusterBuildContext, LinkInput>(
      actor,
      name,
      description,
      options,
      { kind: "ProducerCollateralSteps.LinkInput" },
      runLinkEthereum
    )
  }
  export async function runLinkEthereum(
    ctx: ClusterBuildContext,
    _input: LinkInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const privateKey = PrivateKey.from(
      Steps.registry.readMockSyndicationBonder(ctx).ethereum.privateKey
    )
    await AuthExLinkTool.createLink(ctx.wire, {
      chainKind: ChainKind.EVM,
      account: Constants.FundingAccount,
      privateKey,
      ethereumWallet: new Wallet(privateKey.toNativeString())
    })
  }

  /** Transfer existing backed shadow; this step never issues tokens. */
  export function planFunding(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    token: Constants.CollateralToken
  ) {
    return ClusterBuildStep.create<ClusterBuildContext, FundingInput>(
      actor,
      name,
      description,
      options,
      { kind: "ProducerCollateralSteps.FundingInput", token },
      runFunding
    )
  }
  export async function runFunding(
    ctx: ClusterBuildContext,
    input: FundingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const account = ctx.keyStore.assertOperator(Constants.ProducerLabel).account
    await ctx.wire
      .getSysioContract(SysioContracts.SysioContractName.liq)
      .actions.transfer.invoke(
        {
          from: Constants.FundingAccount,
          to: account,
          quantity: Asset.fromUnits(
            Constants.BondAmount.toString(),
            `${Constants.Precision},${input.token}`
          ).toString(),
          memo: "producer collateral funding"
        },
        {
          authorization: WireClient.activeAuthorization(
            Constants.FundingAccount
          )
        }
      )
  }

  /** Bond shadow already held by the producer, without the WIRE-only funding helper. */
  export function planDeposit(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    token: Constants.CollateralToken
  ) {
    return ClusterBuildStep.create<
      ClusterBuildContext,
      WireCollateralTool.DepositInput
    >(
      actor,
      name,
      description,
      options,
      {
        kind: "WireCollateralTool.DepositInput",
        operatorLabel: Constants.ProducerLabel,
        collateral: Constants.collateral(token, Constants.BondAmount)
      },
      WireCollateralTool.runDeposit
    )
  }

  /** Exact liquid balance checks bracket each bond and each remit payout. */
  export function planVerifyLiquidBalance(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    token: Constants.CollateralToken,
    expected: bigint
  ) {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        Assert.equal(
          await readLiquidBalance(ctx, token),
          expected,
          `${token} liquid balance`
        )
      },
      options
    )
  }
  export async function readLiquidBalance(
    ctx: ClusterBuildContext,
    token: Constants.CollateralToken
  ): Promise<bigint> {
    const account = ctx.keyStore.assertOperator(
        Constants.ProducerLabel
      ).account,
      { rows, more } = await ctx.wire
        .getSysioContract(SysioContracts.SysioContractName.liq)
        .tables.accounts.query({
          scope: account,
          limit: WireCollateralTool.TableRowLimit
        })
    Assert.ok(!more, "truncated producer shadow balance read")
    const balance = rows
      .map(row => Asset.from(row.balance))
      .find(asset => asset.symbol.name === token)
    if (!balance) return 0n
    Assert.equal(
      balance.symbol.precision,
      Constants.Precision,
      "unexpected depot shadow precision"
    )
    return BigInt(balance.units.toString())
  }
}
