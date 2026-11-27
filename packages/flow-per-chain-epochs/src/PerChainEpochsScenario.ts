import { OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"

import { OutpostChainCodename } from "@wireio/cluster-tool-shared"
import {
  BatchOperatorSchedule,
  ClusterBuildDefaults,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  FlowScenario,
  OperatorDaemonTool,
  ProtocolTiming,
  Report,
  Steps,
  SyndicationScenario,
  WireCollateralTool,
  WireEconomicClockTool,
  WireOperatorProvisioningTool,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"

import { PerChainEpochsScenarioConstants as Constants } from "./PerChainEpochsScenarioConstants.js"
import { PerChainEpochsSteps } from "./steps/index.js"

const { Actor } = Report,
  { SysioOpregChainServiceStatus, SysioOpregOperatorstatus } = SysioContracts

/**
 * Each outpost chain runs its own consensus epoch: its own duration, counter, schedule window,
 * operator set and pause. Ethereum runs 60 s epochs and Solana 150 s ones, and four phase groups
 * each assert one claim, independent of the others' outcome so a failure names its phase:
 *
 * 1. **OwnCadence** — each chain's `epochcfg` carries its own duration, and over a 720 s window
 *    each chain's epochs start exactly one of its own durations apart, each closes as often as its
 *    envelope requires, and the 60 s chain advances more often than the 150 s one.
 * 2. **ServesOneChain** — a non-bootstrapped batch operator joins Ethereum only, bonds to ACTIVE
 *    and runs its relay: its only membership is SERVING on Ethereum, Ethereum's window seats it,
 *    Solana's never does, and its seat-seconds are whole Ethereum epochs.
 * 3. **LeavesOneChain** — it joins Solana and Solana seats it; it leaves Ethereum (LEFT): its
 *    Ethereum seat closes, no new Ethereum group seats it through a full rotation, Solana seats
 *    it in a group appended after the leave, and its seat-seconds in a later pay period are
 *    whole Solana epochs.
 * 4. **PausesOneChain** — with Ethereum paused through `sysio.chalg@active` (as an open dispute
 *    pauses it), Solana keeps advancing, and an operator whose only membership is Solana withdraws:
 *    its request waits on Solana's consensus alone and matures into its remit claim while
 *    Ethereum is still held; Ethereum then resumes.
 */
export class PerChainEpochsScenario extends FlowScenario {
  readonly name = "flow-per-chain-epochs"
  readonly description =
    "Each outpost chain runs its own consensus epoch: its own cadence, the operators that serve it, and a pause that holds it alone"

  override readonly defaults: ClusterBuildOptions = {
    outpostEpochDurationSec: Constants.OutpostEpochDurationSec,
    economicEpochDurationSec: Constants.EconomicEpochDurationSec,
    batchOperatorCount: Constants.BatchOperatorCount,
    adHocCount: Constants.AdHocDaemonCount,
    // The flow observes membership, not eviction: at its ceiling the percent rail can breach only
    // when every seat was missed, a run the consecutive rail evicts first. One missed first seat
    // while the serving operator's relay syncs stays inside the default 20-duty sample regardless.
    terminateMaxPercentMisses24h: ClusterBuildDefaults.MaxTerminateMaxPercentMisses24h,
    // Without a requirement `meets_role_min` refuses every non-bootstrapped batch operator, so
    // the serving operator turns ACTIVE only against a minimum the flow installs.
    requiredBatchOperatorCollateral: [
      WireCollateralTool.createWireRequirement(Constants.MinimumBond)
    ]
  }

  plan(cluster: ClusterBuild): void {
    this.planOwnCadence(cluster)
    this.planServesOneChain(cluster)
    this.planLeavesOneChain(cluster)
    this.planPausesOneChain(cluster)
  }

  /** Phase group 1: each chain advances on its own grid, the faster one more often. */
  private planOwnCadence(cluster: ClusterBuild): void {
    const { outpostEpochDurationSec } = cluster.context.config,
      ethereumSec = outpostEpochDurationSec[OutpostChainCodename.ETHEREUM],
      solanaSec = outpostEpochDurationSec[OutpostChainCodename.SOLANA],
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "OwnCadence",
        `Each outpost chain advances on its own epoch grid: the ${ethereumSec} s ${OutpostChainCodename.ETHEREUM} chain more often than the ${solanaSec} s ${OutpostChainCodename.SOLANA} one`
      )

    ClusterBuildPhase.create(
      group,
      "EpochConfiguration",
      "The depot runs each outpost chain at its own configured duration"
    ).push(
      PerChainEpochsSteps.planVerifyEpochConfiguration(
        Actor.Sysio,
        "epoch-configuration",
        `epochcfg runs ${OutpostChainCodename.ETHEREUM} at ${ethereumSec} s and ${OutpostChainCodename.SOLANA} at ${solanaSec} s, each epochstate spaced by its own duration`,
        {},
        outpostEpochDurationSec
      )
    )

    ClusterBuildPhase.create(
      group,
      "ObserveCadence",
      `Both chains run a ${Constants.CadenceWindowSec} s window, each on its own grid`
    ).push(
      WireEconomicClockTool.planRecordClockReading(
        Actor.Sysio,
        "cadence-start",
        "record every chain's consensus epoch at the start of the window",
        {},
        Constants.CadenceStartObservation
      ),
      PerChainEpochsSteps.planAwaitWindowElapsed(
        Actor.Sysio,
        "cadence-window",
        `the depot head runs ${Constants.CadenceWindowSec} s past the start`,
        ProtocolTiming.pollStepOptions(PerChainEpochsSteps.windowDeadlineMs(Constants.CadenceWindowSec)),
        Constants.CadenceStartObservation,
        Constants.CadenceWindowSec
      ),
      WireEconomicClockTool.planRecordClockReading(
        Actor.Sysio,
        "cadence-end",
        "record every chain's consensus epoch at the end of the window",
        {},
        Constants.CadenceEndObservation
      ),
      PerChainEpochsSteps.planVerifyOwnCadence(
        Actor.Sysio,
        "own-cadence",
        "each chain's epochs started one of its own durations apart, each closed as often as its envelope requires, and the faster chain advanced more",
        {},
        Constants.CadenceStartObservation,
        Constants.CadenceEndObservation
      )
    )
  }

  /** Phase group 2: an operator joined to Ethereum alone is seated only there. */
  private planServesOneChain(cluster: ClusterBuild): void {
    const { config } = cluster.context,
      { batchOpGroups } = BatchOperatorSchedule.resolve(config),
      ethereumSec = config.outpostEpochDurationSec[OutpostChainCodename.ETHEREUM],
      label = Constants.ServingOperatorLabel,
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "ServesOneChain",
        "A batch operator joined to Ethereum alone is seated by Ethereum's schedule and never by Solana's"
      ),
      rotationEpochs = batchOpGroups + Constants.RotationMarginEpochs

    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      group,
      "ProvisionServingOperator",
      "Provision the non-bootstrapped batch operator that joins Ethereum only",
      {},
      [
        {
          label,
          type: OperatorType.BATCH,
          isBootstrapped: false,
          servedChains: [OutpostChainCodename.ETHEREUM],
          // Fee-payer funding for the relay's deliveries on both outposts: every key is random
          // and starts at zero, and the operator later serves Solana too.
          fundEthereumWei: WireOperatorProvisioningTool.DefaultEthereumFundWei,
          airdropSolanaLamports: WireOperatorProvisioningTool.DefaultSolanaAirdropLamports
        }
      ]
    )

    ClusterBuildPhase.create(
      group,
      "AdmitServingOperator",
      "Start the operator's relay, bond it to ACTIVE, and check its only membership is Ethereum"
    ).push(
      // The relay starts before the bond, so it is live by the operator's first seat.
      OperatorDaemonTool.planDaemonStart(
        Actor.BatchOperator,
        "start-serving-relay",
        "start the serving operator's relay with its own Ethereum and Solana signing keys",
        SyndicationScenario.VerifyOptions,
        label
      ),
      ...WireCollateralTool.planDeposit(
        Actor.BatchOperator,
        "bond-serving-operator",
        `bond ${Constants.ServingBond} WIRE units through sysio.opreg::deposit`,
        SyndicationScenario.WriteOptions,
        label,
        WireCollateralTool.createWireCollateral(Constants.ServingBond)
      ),
      WireCollateralTool.planVerifyOperatorStatus(
        Actor.Sysio,
        "serving-operator-active",
        "the bond meets the minimum, so the serving operator is OPERATOR_STATUS_ACTIVE",
        {},
        label,
        SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
      ),
      PerChainEpochsSteps.planVerifyMemberships(
        Actor.Sysio,
        "serves-ethereum-only",
        `servchains: SERVING on ${OutpostChainCodename.ETHEREUM}, no ${OutpostChainCodename.SOLANA} row`,
        {},
        label,
        { [OutpostChainCodename.ETHEREUM]: SysioOpregChainServiceStatus.SERVING }
      )
    )

    ClusterBuildPhase.create(
      group,
      "SeatedOnEthereumOnly",
      "Ethereum's schedule seats the operator; Solana's does not"
    ).push(
      PerChainEpochsSteps.planAwaitOperatorSeated(
        Actor.Sysio,
        "seated-on-ethereum",
        "an Ethereum window group seats the serving operator",
        ProtocolTiming.pollStepOptions(
          PerChainEpochsSteps.chainEpochsBudgetMs(config, OutpostChainCodename.ETHEREUM, Constants.ScheduleWindowEpochs)
        ),
        label,
        OutpostChainCodename.ETHEREUM,
        Constants.ScheduleWindowEpochs
      ),
      PerChainEpochsSteps.planVerifyOperatorUnseated(
        Actor.Sysio,
        "not-seated-on-solana",
        "no Solana window group seats the serving operator",
        {},
        label,
        OutpostChainCodename.SOLANA
      )
    )

    ClusterBuildPhase.create(
      group,
      "EthereumSeatSeconds",
      "The operator's duty is whole Ethereum epochs"
    ).push(
      PerChainEpochsSteps.planAwaitSeatSecondsAccrued(
        Actor.Sysio,
        "ethereum-seat-seconds",
        `the operator's ${OutpostChainCodename.ETHEREUM} batchduty seat-seconds are a positive multiple of ${ethereumSec} s, with no other chain's duty in that pay period`,
        ProtocolTiming.pollStepOptions(
          PerChainEpochsSteps.seatSecondsDeadlineMs(config, OutpostChainCodename.ETHEREUM, rotationEpochs)
        ),
        label,
        OutpostChainCodename.ETHEREUM,
        rotationEpochs
      ),
      PerChainEpochsSteps.planVerifyOperatorUnseated(
        Actor.Sysio,
        "still-not-seated-on-solana",
        "after serving Ethereum seats, still no Solana window group seats the operator",
        {},
        label,
        OutpostChainCodename.SOLANA
      )
    )
  }

  /** Phase group 3: leaving Ethereum stops its seats there while Solana keeps seating it. */
  private planLeavesOneChain(cluster: ClusterBuild): void {
    const { config } = cluster.context,
      { batchOpGroups } = BatchOperatorSchedule.resolve(config),
      solanaSec = config.outpostEpochDurationSec[OutpostChainCodename.SOLANA],
      label = Constants.ServingOperatorLabel,
      rotationEpochs = batchOpGroups + Constants.RotationMarginEpochs,
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "LeavesOneChain",
        "The operator joins Solana, then leaves Ethereum: Ethereum stops seating it, Solana keeps seating it"
      )

    ClusterBuildPhase.create(group, "JoinSolana", "The operator joins Solana and Solana seats it").push(
      WireOperatorProvisioningTool.planChainJoin(
        Actor.BatchOperator,
        "join-solana",
        `${label} joins ${OutpostChainCodename.SOLANA} through sysio.opreg::joinchain`,
        SyndicationScenario.WriteOptions,
        label,
        OutpostChainCodename.SOLANA
      ),
      PerChainEpochsSteps.planVerifyMemberships(
        Actor.Sysio,
        "serves-both-chains",
        "servchains: SERVING on both chains",
        {},
        label,
        {
          [OutpostChainCodename.ETHEREUM]: SysioOpregChainServiceStatus.SERVING,
          [OutpostChainCodename.SOLANA]: SysioOpregChainServiceStatus.SERVING
        }
      ),
      PerChainEpochsSteps.planAwaitOperatorSeated(
        Actor.Sysio,
        "seated-on-solana",
        "a Solana window group seats the operator",
        ProtocolTiming.pollStepOptions(
          PerChainEpochsSteps.chainEpochsBudgetMs(config, OutpostChainCodename.SOLANA, Constants.ScheduleWindowEpochs)
        ),
        label,
        OutpostChainCodename.SOLANA,
        Constants.ScheduleWindowEpochs
      )
    )

    ClusterBuildPhase.create(
      group,
      "LeaveEthereum",
      "After leaving Ethereum its Ethereum seat closes and no new one follows, while Solana seats it again"
    ).push(
      WireOperatorProvisioningTool.planChainLeave(
        Actor.BatchOperator,
        "leave-ethereum",
        `${label} leaves ${OutpostChainCodename.ETHEREUM} through sysio.opreg::leavechain`,
        SyndicationScenario.WriteOptions,
        label,
        OutpostChainCodename.ETHEREUM
      ),
      // Taken after the leave, so a group appended past it was appended after the leave too.
      Steps.epochAdvance.planRecordEpochIndices(
        Actor.Sysio,
        "record-leave",
        "record every chain's consensus epoch index after the leave",
        {},
        Constants.LeaveSnapshot
      ),
      PerChainEpochsSteps.planVerifyMemberships(
        Actor.Sysio,
        "left-ethereum",
        `servchains: LEFT on ${OutpostChainCodename.ETHEREUM}, SERVING on ${OutpostChainCodename.SOLANA}`,
        {},
        label,
        {
          [OutpostChainCodename.ETHEREUM]: SysioOpregChainServiceStatus.LEFT,
          [OutpostChainCodename.SOLANA]: SysioOpregChainServiceStatus.SERVING
        }
      ),
      PerChainEpochsSteps.planAwaitOperatorUnseated(
        Actor.Sysio,
        "ethereum-seat-closes",
        "the operator's resident Ethereum seat closes",
        ProtocolTiming.pollStepOptions(
          PerChainEpochsSteps.chainEpochsBudgetMs(config, OutpostChainCodename.ETHEREUM, rotationEpochs)
        ),
        label,
        OutpostChainCodename.ETHEREUM,
        rotationEpochs
      ),
      PerChainEpochsSteps.planVerifyUnseatedForRotation(
        Actor.Sysio,
        "no-new-ethereum-seat",
        `through ${rotationEpochs} Ethereum epochs no new Ethereum group seats the operator`,
        ProtocolTiming.pollStepOptions(
          PerChainEpochsSteps.chainEpochsBudgetMs(config, OutpostChainCodename.ETHEREUM, rotationEpochs)
        ),
        label,
        OutpostChainCodename.ETHEREUM,
        rotationEpochs
      ),
      PerChainEpochsSteps.planAwaitOperatorReseated(
        Actor.Sysio,
        "solana-seats-again",
        "Solana seats the operator in a group appended after the leave",
        ProtocolTiming.pollStepOptions(
          PerChainEpochsSteps.chainEpochsBudgetMs(config, OutpostChainCodename.SOLANA, rotationEpochs)
        ),
        label,
        OutpostChainCodename.SOLANA,
        Constants.LeaveSnapshot,
        rotationEpochs
      )
    )

    ClusterBuildPhase.create(
      group,
      "SolanaSeatSeconds",
      "In a pay period after its last Ethereum seat closed, the operator's duty is whole Solana epochs"
    ).push(
      PerChainEpochsSteps.planRecordDutyPeriod(
        Actor.Sysio,
        "record-solana-only-period",
        "record dutystate.open_period once every Ethereum seat of the operator has closed",
        {},
        Constants.SolanaOnlyDutyPeriod
      ),
      PerChainEpochsSteps.planAwaitSeatSecondsAccrued(
        Actor.Sysio,
        "solana-seat-seconds",
        `in a later pay period the operator's ${OutpostChainCodename.SOLANA} batchduty seat-seconds are a positive multiple of ${solanaSec} s, with no other chain's duty in that period`,
        ProtocolTiming.pollStepOptions(
          PerChainEpochsSteps.seatSecondsDeadlineMs(config, OutpostChainCodename.SOLANA, rotationEpochs)
        ),
        label,
        OutpostChainCodename.SOLANA,
        rotationEpochs,
        Constants.SolanaOnlyDutyPeriod
      )
    )
  }

  /** Phase group 4: a pause holds one chain alone, and a withdrawal waiting on the other matures. */
  private planPausesOneChain(cluster: ClusterBuild): void {
    const { config } = cluster.context,
      label = Constants.WithdrawerLabel,
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "PausesOneChain",
        "Pausing Ethereum holds Ethereum alone: Solana advances and a withdrawal waiting on Solana matures"
      )

    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      group,
      "ProvisionWithdrawer",
      "Provision the non-bootstrapped batch operator that joins Solana only",
      {},
      [
        {
          label,
          type: OperatorType.BATCH,
          isBootstrapped: false,
          servedChains: [OutpostChainCodename.SOLANA]
        }
      ]
    )

    ClusterBuildPhase.create(
      group,
      "BondWithdrawer",
      "The withdrawer bonds below the minimum, stays unscheduled, and serves Solana alone"
    ).push(
      ...WireCollateralTool.planDeposit(
        Actor.BatchOperator,
        "bond-withdrawer",
        `bond ${Constants.WithdrawerBond} WIRE units through sysio.opreg::deposit`,
        SyndicationScenario.WriteOptions,
        label,
        WireCollateralTool.createWireCollateral(Constants.WithdrawerBond)
      ),
      WireCollateralTool.planVerifyOperatorStatus(
        Actor.Sysio,
        "withdrawer-unscheduled",
        "below the minimum the withdrawer stays OPERATOR_STATUS_UNKNOWN, so no schedule seats it",
        {},
        label,
        SysioOpregOperatorstatus.OPERATOR_STATUS_UNKNOWN
      ),
      PerChainEpochsSteps.planVerifyMemberships(
        Actor.Sysio,
        "withdrawer-serves-solana-only",
        `servchains: SERVING on ${OutpostChainCodename.SOLANA}, no ${OutpostChainCodename.ETHEREUM} row`,
        {},
        label,
        { [OutpostChainCodename.SOLANA]: SysioOpregChainServiceStatus.SERVING }
      )
    )

    ClusterBuildPhase.create(
      group,
      "PauseEthereum",
      "Governance pauses Ethereum's consensus epoch through sysio.chalg@active"
    ).push(
      Steps.contracts.sysio.epoch.planPause(
        Actor.Sysio,
        "pause-ethereum",
        "pause the Ethereum consensus epoch, as an open dispute on Ethereum does",
        SyndicationScenario.WriteOptions,
        { chain_code: OutpostChainCodename.ETHEREUM }
      ),
      WireEconomicClockTool.planRecordClockReading(
        Actor.Sysio,
        "record-paused-start",
        "record both clocks and every chain's consensus with Ethereum paused",
        {},
        Constants.PausedStartObservation
      )
    )

    ClusterBuildPhase.create(
      group,
      "WithdrawOnSolanaConsensus",
      "A withdrawal waiting on Solana alone matures while Ethereum is held"
    ).push(
      Steps.epochAdvance.planRecordEpochIndices(
        Actor.Sysio,
        "record-withdrawal-request",
        "record every chain's consensus epoch index right before the request",
        {},
        Constants.WithdrawalSnapshot
      ),
      WireCollateralTool.planWithdrawal(
        Actor.BatchOperator,
        "withdraw",
        `withdraw ${Constants.WithdrawAmount} WIRE units of the bond`,
        SyndicationScenario.WriteOptions,
        label,
        WireCollateralTool.createWireCollateral(Constants.WithdrawAmount)
      ),
      PerChainEpochsSteps.planVerifyWithdrawalWaits(
        Actor.Sysio,
        "waits-on-solana-alone",
        `the request's consensus_waits name ${OutpostChainCodename.SOLANA} alone, ${WireCollateralTool.WithdrawWaitConsensusEpochs} epochs past the request`,
        {},
        label,
        OutpostChainCodename.SOLANA,
        Constants.WithdrawalSnapshot
      ),
      WireCollateralTool.planVerifyRemitClaim(
        Actor.Sysio,
        "withdrawal-matures",
        `remitclaims{${label}, WIRE} holds exactly ${Constants.WithdrawAmount} with Ethereum still paused`,
        { timeoutMs: WireCollateralTool.remitClaimStepTimeoutMs(config) },
        label,
        WireCollateralTool.createWireClaim(Constants.WithdrawAmount)
      ),
      WireEconomicClockTool.planRecordClockReading(
        Actor.Sysio,
        "record-paused-end",
        "record both clocks and every chain's consensus after the withdrawal matured",
        {},
        Constants.PausedEndObservation
      ),
      WireEconomicClockTool.planVerifyConsensusHeld(
        Actor.Sysio,
        "ethereum-held",
        "Ethereum stayed paused at one epoch while the economic clock kept opening epochs",
        {},
        OutpostChainCodename.ETHEREUM,
        [Constants.PausedStartObservation, Constants.PausedEndObservation]
      ),
      WireEconomicClockTool.planVerifyConsensusAdvanced(
        Actor.Sysio,
        "solana-advanced",
        "Solana ran unpaused and advanced as its envelope requires while Ethereum was held",
        {},
        OutpostChainCodename.SOLANA,
        Constants.PausedStartObservation,
        Constants.PausedEndObservation
      )
    )

    ClusterBuildPhase.create(group, "ResumeEthereum", "Ethereum resumes once unpaused").push(
      Steps.contracts.sysio.epoch.planUnpause(
        Actor.Sysio,
        "unpause-ethereum",
        "clear the Ethereum pause",
        SyndicationScenario.WriteOptions,
        { chain_code: OutpostChainCodename.ETHEREUM }
      ),
      PerChainEpochsSteps.planAwaitConsensusAdvanced(
        Actor.Sysio,
        "ethereum-resumes",
        `the Ethereum consensus advances ${Constants.ResumeEpochs} epoch(s) after the unpause`,
        ProtocolTiming.pollStepOptions(
          PerChainEpochsSteps.chainEpochsBudgetMs(config, OutpostChainCodename.ETHEREUM, Constants.ResumeBudgetEpochs)
        ),
        OutpostChainCodename.ETHEREUM,
        Constants.ResumeEpochs,
        Constants.ResumeBudgetEpochs
      )
    )
  }
}
