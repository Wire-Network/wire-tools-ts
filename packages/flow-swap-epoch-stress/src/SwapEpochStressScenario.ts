import Assert from "node:assert"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import type { Logger } from "@wireio/shared"
import {
  ClusterBuildPhase,
  Constants as ClusterConstants,
  FlowScenario,
  Report,
  SwapScenarioContext,
  SwapUserIdentities,
  WireReserveTool,
  WireUnderwriterTool,
  matchesProtoEnum,
  pollUntil,
  swapUserOutputKey,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { SwapEpochStressScenarioConstants as Constants } from "./SwapEpochStressScenarioConstants.js"
import {
  StressBaselineEpochKey,
  StressBaselineUwreqIdsKey,
  StressSolanaBalancesBeforeKey,
  StressTargetAmountKey
} from "./SwapEpochStressScenarioOutputs.js"
import { SwapEpochStressScenarioSteps as StressSteps } from "./steps/index.js"

const { SysioContractName, SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report

/** Manual, report-first concurrent swap settlement and epoch-liveness stress test. */
export class SwapEpochStressScenario extends FlowScenario<SwapScenarioContext> {
  /** Flow package and cluster name. */
  readonly name = "flow-swap-epoch-stress"
  /** Human-readable load shape shown in generated reports. */
  readonly description =
    "Ten concurrent Ethereum→Solana swaps across 21 producers and 21 batch operators, with settlement and epoch-liveness diagnostics"

  /** Fresh-cluster topology and protocol settings required by this flow. */
  override readonly defaults: ClusterBuildOptions = {
    enableMockReserves: true,
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount,
    requiredUnderwriterCollateral: [
      {
        chainCode: Constants.EthereumChainCode,
        tokenCode: Constants.EthereumTokenCode,
        minimumBond: Constants.UnderwriterMinimumBond
      },
      {
        chainCode: Constants.SolanaChainCode,
        tokenCode: Constants.SolanaTokenCode,
        minimumBond: Constants.UnderwriterMinimumBond
      }
    ]
  }

  /**
   * Create the swap-aware context used by every scenario phase.
   *
   * @param config Resolved cluster configuration.
   * @param log Scenario logger.
   * @returns A swap scenario context for the new cluster.
   */
  override createContext(
    config: ClusterConfig,
    log: Logger
  ): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  /**
   * Register the underwriter, actor, request, payout, and diagnostic phases.
   *
   * @param cluster Cluster build receiving this scenario's phases.
   * @returns Nothing.
   */
  plan(cluster: ClusterBuild<SwapScenarioContext>): void {
    const firstUnderwriter = ClusterConstants.underwriterLabel(0)
    const requestOptions = { timeoutMs: Constants.RequestStepTimeoutMs }
    const diagnosticsOptions = {
      timeoutMs:
        Constants.SettlementDeadlineMs +
        Constants.observationStepTimeoutMs() +
        Constants.PollDeadlineBufferMs
    }

    WireUnderwriterTool.planCollateralDeposit(
      cluster,
      "UnderwriterCollateral",
      "Bond the underwriter on both outposts before applying swap load",
      requestOptions,
      [firstUnderwriter],
      cluster.context.config.underwriterCollateral ??
        WireUnderwriterTool.load(null, Constants.UnderwriterCount)
    )

    ClusterBuildPhase.create(
      cluster,
      "StressActors",
      "Create ten distinct Ethereum senders and ten distinct Solana recipients",
      Array.from({ length: Constants.ActorCount }, (_, actorIndex) =>
        SwapUserIdentities.planIdentityCreation(
          Actor.User,
          `stress-actor-${actorIndex + 1}`,
          `create Ethereum sender ${actorIndex + 1} and Solana recipient ${actorIndex + 1}`,
          requestOptions,
          SwapUserIdentities.DefaultEthereumHdIndex + actorIndex,
          actorIndex
        )
      ),
      { parallelize: true }
    )

    ClusterBuildPhase.create(
      cluster,
      "PreLoadGate",
      "Require an active underwriter, healthy reserves, and capture the pre-load baseline"
    ).push(
      verifyStep(
        Actor.Underwriter,
        "underwriter-active",
        `${firstUnderwriter} is ACTIVE before swaps are submitted`,
        async ctx => {
          const account = ctx.keyStore.assertOperator(firstUnderwriter).account
          await pollUntil(
            `${firstUnderwriter} ACTIVE`,
            async () => {
              const { rows } = await ctx.wire
                .getSysioContract(SysioContractName.opreg)
                .tables.operators.query({ limit: 100 })
              const row = rows.find(operator => operator.account === account)
              return (
                row != null &&
                matchesProtoEnum(
                  row.status,
                  SysioOpregOperatorstatus,
                  SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
                )
              )
            },
            Constants.underwriterActiveDeadlineMs(),
            Constants.LongPollIntervalMs
          )
        },
        {
          timeoutMs:
            Constants.underwriterActiveDeadlineMs() +
            Constants.PollDeadlineBufferMs
        }
      ),
      verifyStep(
        Actor.Sysio,
        "capture-pre-load-baseline",
        "verify reserves, compute the live quote, and snapshot epoch/UWREQ IDs",
        async ctx => {
          await ctx.reserveBook(
            Constants.EthereumChainCode,
            Constants.EthereumTokenCode,
            Constants.PrimaryReserveCode
          )
          await ctx.reserveBook(
            Constants.SolanaChainCode,
            Constants.SolanaTokenCode,
            Constants.PrimaryReserveCode
          )
          const targetAmount = await WireReserveTool.swapquote(ctx.wire, {
            from: {
              chainCode: Constants.EthereumChainCode,
              tokenCode: Constants.EthereumTokenCode,
              reserveCode: Constants.PrimaryReserveCode
            },
            fromAmount: Constants.SourceEthereumWei / Constants.WeiPerDepotUnit,
            to: {
              chainCode: Constants.SolanaChainCode,
              tokenCode: Constants.SolanaTokenCode,
              reserveCode: Constants.PrimaryReserveCode
            }
          })
          Assert.ok(targetAmount > 0n, "ETH→SOL live swap quote is zero")
          const { rows: epochRows } = await ctx.wire.getEpochState()
          Assert.ok(epochRows[0], "sysio.epoch::epochstate is empty")
          const { rows: requestRows } = await ctx.wire
            .getSysioContract(SysioContractName.uwrit)
            .tables.uwreqs.query()
          const baselineEpoch = Number(epochRows[0].current_epoch_index)
          const baselineUwreqIds = requestRows.map(request =>
            Number(request.id)
          )
          const solanaBalancesBefore = await Promise.all(
            Array.from({ length: Constants.ActorCount }, (_, actorIndex) => {
              const swapUser = ctx.outputs.assert(swapUserOutputKey(actorIndex))
              return ctx.solana.getLamports(swapUser.solanaKeypair.publicKey)
            })
          )
          ctx.outputs
            .set(StressTargetAmountKey, targetAmount)
            .set(StressBaselineEpochKey, baselineEpoch)
            .set(StressBaselineUwreqIdsKey, baselineUwreqIds)
            .set(StressSolanaBalancesBeforeKey, solanaBalancesBefore)
          Report.StepExtraRecorder.note("pre-load baseline captured", {
            targetAmount,
            baselineEpoch,
            baselineUwreqIds,
            solanaBalancesBefore
          })
        }
      )
    )

    ClusterBuildPhase.create(
      cluster,
      "ConcurrentRequests",
      "Launch ten Ethereum→Solana requestSwap transactions at the same time",
      Array.from({ length: Constants.ActorCount }, (_, actorIndex) =>
        StressSteps.planRequestSwap(
          Actor.User,
          `request-swap-${actorIndex + 1}`,
          `Ethereum actor ${actorIndex + 1} swaps to Solana recipient ${actorIndex + 1}`,
          requestOptions,
          actorIndex
        )
      ),
      { parallelize: true }
    )

    ClusterBuildPhase.create(
      cluster,
      "TerminalDiagnostics",
      "Observe request settlement once, then evaluate every invariant through the 15-epoch soak",
      [
        StressSteps.planTerminalDiagnostics(
          Actor.Sysio,
          "post-load-swap-epoch-health",
          "report request, UWREQ, payout, epoch-liveness, and chain-runtime results",
          diagnosticsOptions,
          Constants.ActorCount
        )
      ]
    )
  }
}
