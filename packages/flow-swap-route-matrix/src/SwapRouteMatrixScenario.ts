import Assert from "node:assert"

import type {
  ChainTokenAmount,
  ClusterConfig
} from "@wireio/cluster-tool-shared"
import { TokenAmount } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildFailureMode,
  ClusterBuildPhase,
  Constants as HarnessConstants,
  FlowScenario,
  Report,
  SwapScenarioContext,
  SwapUserIdentities,
  WireUnderwriterTool,
  matchesProtoEnum,
  pollUntil,
  resolveClusterBuildFailureMode,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions,
  type ClusterBuildStepOptions,
  type Logger
} from "@wireio/cluster-tool"

import { planSwapRouteMatrix } from "./SwapRouteMatrixPlan.js"
import { SwapRouteMatrixScenarioConstants as Constants } from "./SwapRouteMatrixScenarioConstants.js"
import { SwapRouteMatrixScenarioSteps as Steps } from "./steps/index.js"

const { SysioContractName, SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report

/**
 * Exhaustive conformance matrix for every configured public token route. The
 * scenario owns shared cluster/user/collateral prerequisites and delegates the
 * reusable Family → Direction → Route hierarchy to {@link planSwapRouteMatrix}.
 */
export class SwapRouteMatrixScenario extends FlowScenario<SwapScenarioContext> {
  readonly name = "flow-swap-route-matrix"
  readonly description =
    "Exhaustive configured route matrix across ETH, LIQETH, USDC, USDT, SOL, LIQSOL, USDCSOL, USDTSOL, and WIRE"

  override readonly defaults: ClusterBuildOptions = {
    enableMockReserves: true,
    epochDurationSec: Constants.EpochDurationSec,
    requiredUnderwriterCollateral: [
      {
        chainCode: Constants.EthereumChainCode,
        tokenCode: Constants.EthereumTokens[0].tokenCode,
        minimumBond: Constants.UnderwriterMinimumBond
      },
      {
        chainCode: Constants.SolanaChainCode,
        tokenCode: Constants.SolanaTokens[0].tokenCode,
        minimumBond: Constants.UnderwriterMinimumBond
      }
    ]
  }

  /** Create the shared swap-aware context used by every route step. */
  override createContext(
    config: ClusterConfig,
    log: Logger
  ): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  /** Append shared prerequisites followed by the reusable exhaustive matrix. */
  plan(cluster: ClusterBuild<SwapScenarioContext>): void {
    Assert.strictEqual(
      Constants.AllRoutes.length,
      Constants.ConfiguredRouteCount,
      "configured swap route catalog must contain every meaningful ordered pair"
    )

    const underwriterLabels = Array.from(
        { length: cluster.context.config.underwriterCount },
        (_, index) => HarnessConstants.underwriterLabel(index)
      ),
      collateral = buildUnderwriterCollateral(underwriterLabels.length),
      writeOptions: ClusterBuildStepOptions = {
        timeoutMs: Constants.WriteTimeoutMs
      },
      activeOptions: ClusterBuildStepOptions = {
        timeoutMs:
          Constants.UnderwriterActiveDeadlineMs + Constants.PollDeadlineBufferMs
      },
      failureMode = resolveClusterBuildFailureMode(
        process.env[Constants.FailureModeEnvVar],
        ClusterBuildFailureMode.CollectAll
      )

    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "PrerequisiteHealth",
      "WIRE produces blocks and all eight configured public reserves exist",
      [
        verifyStep<SwapScenarioContext>(
          Actor.Sysio,
          "chain-producing",
          "WIRE chain reports a positive head block",
          async ctx => {
            const info = await ctx.wire.getInfo()
            Assert.ok(
              Number(info.head_block_num) > 0,
              "WIRE head_block_num must be positive"
            )
          }
        ),
        ...Constants.ExternalTokens.map(token =>
          verifyStep<SwapScenarioContext>(
            Actor.Sysio,
            `reserve-${token.id}`,
            `${token.endpoint}/${token.symbol}/PRIMARY reserve exists`,
            async ctx => {
              await ctx.reserveBook(
                token.chainCode,
                token.tokenCode,
                Constants.PrimaryReserveCode
              )
            }
          )
        )
      ]
    )

    SwapUserIdentities.planIdentityProvisioning<SwapScenarioContext>(
      cluster,
      "SwapUser",
      "Provision one paired Ethereum and Solana swap identity",
      writeOptions
    )

    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "WireUser",
      "Provision the WIRE recipient and funded from-WIRE depositor"
    ).push(
      Steps.planProvisionWireUser(
        Actor.User,
        "provision-wire-user",
        `provision and fund ${Constants.WireUserAccount}`,
        writeOptions,
        Constants.WireUserAccount,
        Constants.WireUserFunding
      )
    )

    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "LiqEthReserveLiquidity",
      "Bring physical LIQETH custody up to the configured logical reserve floor"
    ).push(
      Steps.planAcquireLiqEthReserveLiquidity(
        Actor.EthereumOutpost,
        "acquire-liqeth-liquidity",
        "deployer acquires any LIQETH shortfall through DepositManager",
        writeOptions,
        Constants.LiqEthReserveFunding
      ),
      Steps.planTransferLiqEthReserveLiquidity(
        Actor.EthereumOutpost,
        "fund-liqeth-reserve",
        "transfer the remaining LIQETH shortfall into ReserveManager custody",
        writeOptions,
        Constants.LiqEthReserveFunding
      )
    )

    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "SwapUserTokens",
      "Fund every configured non-native source token for all route directions",
      [
        ...Constants.EthereumTokens.filter(
          token => token.symbol !== Constants.EthereumNativeSymbol
        ).map(token =>
          Steps.planFundErc20SwapUser(
            Actor.User,
            `fund-${token.id}`,
            `fund the swap user with ${token.symbol}`,
            writeOptions,
            token,
            token.sourceAmount * Constants.UserFundingMultiple
          )
        ),
        ...Constants.SolanaTokens.filter(
          token => token.symbol !== Constants.SolanaNativeSymbol
        ).map(token =>
          Steps.planFundSplSwapUser(
            Actor.User,
            `fund-${token.id}`,
            `fund the swap user with ${token.symbol}`,
            writeOptions,
            token,
            token.sourceAmount * Constants.UserFundingMultiple
          )
        )
      ]
    )

    WireUnderwriterTool.planCollateralDeposit<SwapScenarioContext>(
      cluster,
      "UnderwriterCollateral",
      "Bond every configured external (chain, token) collateral bucket",
      writeOptions,
      underwriterLabels,
      collateral
    )

    ClusterBuildPhase.create<SwapScenarioContext>(
      cluster,
      "UnderwriterReadiness",
      "Wait for all configured bonds to credit and every underwriter to activate"
    ).push(
      Steps.planVerifyUnderwriterBondsRelayed(
        Actor.Sysio,
        "all-bonds-relayed",
        "every exact configured collateral bucket is credited on sysio.opreg",
        activeOptions,
        underwriterLabels,
        collateral
      ),
      verifyStep<SwapScenarioContext>(
        Actor.Underwriter,
        "underwriters-active",
        "every configured underwriter reaches OPERATOR_STATUS_ACTIVE",
        async ctx => {
          await pollUntil(
            "all matrix underwriters ACTIVE",
            () => readAllUnderwritersActive(ctx, underwriterLabels),
            Constants.UnderwriterActiveDeadlineMs,
            Constants.PollIntervalMs
          )
        },
        activeOptions
      )
    )

    planSwapRouteMatrix(cluster, failureMode)
  }
}

/** Build one uniform full-token collateral plan per configured underwriter. */
function buildUnderwriterCollateral(
  underwriterCount: number
): ChainTokenAmount[][] {
  return Array.from({ length: underwriterCount }, () =>
    Constants.ExternalTokens.map(token => ({
      chain_code: token.chainCode,
      amount: TokenAmount.create({
        tokenCode: BigInt(token.tokenCode),
        amount: Constants.UnderwriterCollateralAmount
      })
    }))
  )
}

/** Read whether every configured underwriter is ACTIVE on the depot. */
async function readAllUnderwritersActive(
  ctx: SwapScenarioContext,
  underwriterLabels: string[]
): Promise<boolean> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.opreg)
    .tables.operators.query({ limit: Constants.OperatorTableRowLimit })
  return underwriterLabels.every(label => {
    const account = ctx.keyStore.assertOperator(label).account,
      row = rows.find(operator => operator.account === account)
    return (
      row != null &&
      matchesProtoEnum(
        row.status,
        SysioOpregOperatorstatus,
        SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
      )
    )
  })
}
