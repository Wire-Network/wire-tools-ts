import Assert from "node:assert"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import type { Logger } from "@wireio/shared"
import {
  ClusterBuildFailureMode,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  Constants as ClusterConstants,
  FlowScenario,
  Report,
  SwapScenarioContext,
  WireReserveTool,
  WireUnderwriterTool,
  matchesProtoEnum,
  pollUntil,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { SwapEpochStressScenarioConstants as Constants } from "./SwapEpochStressScenarioConstants.js"
import {
  StressBaselineEpochKey,
  StressBaselineUwreqIdsKey,
  StressTargetAmountKey
} from "./SwapEpochStressScenarioOutputs.js"
import { SwapEpochStressScenarioSteps as StressSteps } from "./steps/index.js"

const { SysioContractName, SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report

/** Manual, report-first reproduction for the Solana terminal/epoch-stall load. */
export class SwapEpochStressScenario extends FlowScenario<SwapScenarioContext> {
  readonly name = "flow-swap-epoch-stress"
  readonly description =
    "Ten concurrent Ethereum→Solana swaps across 21 producers and 21 batch operators, with settlement and epoch-liveness diagnostics"

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

  override createContext(
    config: ClusterConfig,
    log: Logger
  ): SwapScenarioContext {
    return new SwapScenarioContext(config, log)
  }

  plan(cluster: ClusterBuild<SwapScenarioContext>): void {
    const firstUnderwriter = ClusterConstants.underwriterLabel(0)
    const requestOptions = { timeoutMs: Constants.RequestStepTimeoutMs }
    const settlementOptions = {
      timeoutMs: Constants.SettlementDeadlineMs + Constants.PollDeadlineBufferMs
    }
    const diagnosticsOptions = {
      timeoutMs:
        Constants.postLoadEpochDeadlineMs() +
        Constants.PollDeadlineBufferMs +
        120_000
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
        StressSteps.planProvisionActor(
          Actor.User,
          `stress-actor-${actorIndex + 1}`,
          `create Ethereum sender ${actorIndex + 1} and Solana recipient ${actorIndex + 1}`,
          {},
          actorIndex,
          Constants.EthereumHdIndexBase + actorIndex
        )
      ),
      {
        parallelize: true,
        failureMode: ClusterBuildFailureMode.collect
      }
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
            .tables.uwreqs.query({ limit: 256 })
          const baselineEpoch = Number(epochRows[0].current_epoch_index)
          const baselineUwreqIds = requestRows.map(request =>
            Number(request.id)
          )
          ctx.outputs
            .set(StressTargetAmountKey, targetAmount)
            .set(StressBaselineEpochKey, baselineEpoch)
            .set(StressBaselineUwreqIdsKey, baselineUwreqIds)
          Report.StepExtraRecorder.note("pre-load baseline captured", {
            targetAmount,
            baselineEpoch,
            baselineUwreqIds
          })
        }
      )
    )

    const stress = ClusterBuildPhaseGroup.create(
      cluster,
      "ConcurrentSwapStress",
      "Apply simultaneous swaps, collect every result, and always run terminal diagnostics",
      { failureMode: ClusterBuildFailureMode.collect }
    )

    ClusterBuildPhase.create(
      stress,
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
      {
        parallelize: true,
        failureMode: ClusterBuildFailureMode.collect
      }
    )

    ClusterBuildPhase.create(
      stress,
      "DestinationPayouts",
      "Verify all ten distinct Solana recipients receive their remit payouts",
      Array.from({ length: Constants.ActorCount }, (_, actorIndex) =>
        StressSteps.planVerifyPayout(
          Actor.SolanaOutpost,
          `verify-payout-${actorIndex + 1}`,
          `Solana recipient ${actorIndex + 1} receives the expected target amount`,
          settlementOptions,
          actorIndex
        )
      ),
      {
        parallelize: true,
        failureMode: ClusterBuildFailureMode.collect
      }
    )

    ClusterBuildPhase.create(
      stress,
      "TerminalDiagnostics",
      "Prove all UWREQs confirmed, the epoch remains live, and Solana logs are clean",
      [
        StressSteps.planTerminalDiagnostics(
          Actor.Sysio,
          "post-load-epoch-and-solana-health",
          "require three post-load epoch advances and report UWREQ/Solana memory evidence",
          diagnosticsOptions,
          Constants.ActorCount
        )
      ],
      { failureMode: ClusterBuildFailureMode.collect }
    )
  }
}
