import { OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  FlowScenario,
  Report,
  Steps,
  SyndicationScenario,
  WireCollateralTool,
  WireEconomicClockTool,
  WireOperatorProvisioningTool,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"

import { EconomicClockScenarioConstants as Constants } from "./EconomicClockScenarioConstants.js"
import { EconomicClockSteps } from "./steps/index.js"

const { Actor } = Report,
  { WithdrawalWait } = EconomicClockSteps,
  { SysioOpregOperatorstatus } = SysioContracts

/**
 * The economic clock beside the consensus epoch. `sysio.epoch` runs two clocks: the consensus
 * epoch advances on outpost consensus and stops while paused, and the economic clock opens epochs
 * on its own wall-clock grid through the batch operators' `tickeconomy` crank. Emissions accrue
 * and pay, and collateral withdrawals mature, on the economic clock. With the economic epoch at
 * twice the consensus epoch, the flow runs four phase groups, each independent of the others'
 * outcome so a failure names its phase:
 *
 * 1. **ClocksIndependent** — the depot runs the configured clocks; five economic epochs open on
 *    their grid while consensus advances more often (the envelope guarantees it), every economic
 *    epoch pays one period into `epochlog`, and the producer's credited `payclaims` pays out
 *    through `claimpay`.
 * 2. **WithdrawalWaitsOnBothClocks** — a non-bootstrapped operator bonds WIRE and withdraws
 *    twice. The first request's consensus guard passes first and it stays queued until its
 *    economic wait passes; for the second, governance pauses consensus (as a dispute would), the
 *    economic wait passes and it stays queued until consensus resumes and its guard passes. Each
 *    matures into the operator's remit claim only once both have passed.
 * 3. **HeldEmissions** — `sysio`'s spendable WIRE moves to a holder, so the readiness gate holds
 *    the next pay epoch (`BALANCE_INSUFFICIENT` in `blocklog`) while it still accrues. Both clocks
 *    keep running and an envelope round trip with each outpost completes during the hold. The
 *    refund lets the next economic epoch pay the whole held period and close the episode.
 * 4. **AndonCord** — with the depot cord pulled, an economic epoch still pays and the producer's
 *    `claimpay` still succeeds; the cord is then cleared.
 */
export class EconomicClockScenario extends FlowScenario {
  readonly name = "flow-economic-clock"
  readonly description =
    "The economic clock runs beside consensus: emissions pay on it, withdrawals wait on both clocks, a held payout leaves OPP running and pays the whole period once funded, and the andon cord leaves emissions and claims working"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    economicEpochDurationSec: Constants.EconomicEpochDurationSec,
    producerCount: Constants.ProducerCount
  }

  plan(cluster: ClusterBuild): void {
    this.planClocksIndependent(cluster)
    this.planWithdrawalWaitsOnBothClocks(cluster)
    this.planHeldEmissions(cluster)
    this.planAndonCord(cluster)
  }

  /** Phase group 1: both clocks run on their own grids, and emissions pay on the economic one. */
  private planClocksIndependent(cluster: ClusterBuild): void {
    const { economicEpochDurationSec } = cluster.context.config,
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "ClocksIndependent",
        "The economic clock opens epochs on its own grid, consensus advances about twice as often, and emissions pay on economic epochs"
      )

    ClusterBuildPhase.create(
      group,
      "ClockConfiguration",
      "The depot runs the configured economic and consensus clocks"
    ).push(
      EconomicClockSteps.planVerifyClockConfiguration(
        Actor.Sysio,
        "clock-configuration",
        `economycfg runs ${economicEpochDurationSec} s economic epochs beside ${cluster.context.config.epochDurationSec} s consensus epochs; every economic epoch pays; t5state starts on the economic grid`,
        {}
      )
    )

    ClusterBuildPhase.create(
      group,
      "ObserveClocks",
      `${Constants.ClockObservationEpochs} economic epochs open on their grid while consensus runs faster`
    ).push(
      WireEconomicClockTool.planAwaitEconomicEpochsOpened(
        Actor.BatchOperator,
        "economic-epochs-open",
        `the batch operators' tickeconomy crank opens ${Constants.ClockObservationEpochs} economic epochs`,
        {
          timeoutMs: WireEconomicClockTool.awaitEconomicEpochsStepTimeoutMs(
            economicEpochDurationSec,
            Constants.ClockObservationEpochs
          )
        },
        Constants.ClockObservationEpochs,
        Constants.ClockObservation
      ),
      WireEconomicClockTool.planVerifyEconomicGrid(
        Actor.Sysio,
        "economic-grid",
        "each economic epoch starts at start_time + (N - 1) x duration and spans one duration",
        {},
        Constants.ClockObservation
      ),
      EconomicClockSteps.planVerifyConsensusCadence(
        Actor.Sysio,
        "consensus-cadence",
        "consensus advanced at least as often as its envelope requires, and more often than the economic clock",
        {},
        Constants.ClockObservation
      ),
      EconomicClockSteps.planVerifyEmissionsPaidPerEconomicEpoch(
        Actor.Sysio,
        "emissions-per-economic-epoch",
        "every economic epoch paid exactly one period into epochlog, and no emissions block is open",
        {},
        Constants.ClockObservation
      )
    )

    this.planClaimProducerPay(
      group,
      "ClaimProducerPay",
      "The producer's credited epoch pay is claimable",
      Constants.ClockPayClaim
    )
  }

  /** Phase group 2: a withdrawal matures only once its economic wait AND consensus guard pass. */
  private planWithdrawalWaitsOnBothClocks(cluster: ClusterBuild): void {
    const { config } = cluster.context,
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "WithdrawalWaitsOnBothClocks",
        "A collateral withdrawal matures only once both its economic wait and its consensus guard have passed"
      ),
      nextEconomicEpochOptions = {
        timeoutMs: WireEconomicClockTool.awaitEconomicEpochsStepTimeoutMs(
          config.economicEpochDurationSec,
          Constants.NextEconomicEpoch
        )
      },
      // The same config the claim verify's runner reads (`ctx.config`).
      remitClaimStepOptions = {
        timeoutMs: WireCollateralTool.remitClaimStepTimeoutMs(config)
      },
      label = Constants.WithdrawerLabel

    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      group,
      "ProvisionWithdrawer",
      "Provision the non-bootstrapped withdrawing batch operator",
      {},
      [{ label, type: OperatorType.BATCH, isBootstrapped: false }]
    )

    ClusterBuildPhase.create(
      group,
      "BondWithdrawer",
      "The withdrawer bonds WIRE on the depot and stays unscheduled"
    ).push(
      ...WireCollateralTool.planDeposit(
        Actor.BatchOperator,
        "bond-withdrawer",
        `bond ${Constants.BondAmount} WIRE units through sysio.opreg::deposit`,
        {},
        label,
        WireCollateralTool.createWireCollateral(Constants.BondAmount)
      ),
      WireCollateralTool.planVerifyBalanceRow(
        Actor.Sysio,
        "withdrawer-bond-held",
        `the (WIRE, WIRE) balance row holds exactly ${Constants.BondAmount}`,
        {},
        label,
        WireCollateralTool.createWireCollateral(Constants.BondAmount)
      ),
      EconomicClockSteps.planVerifyOperatorStatus(
        Actor.Sysio,
        "withdrawer-unscheduled",
        "with no collateral minimum configured the withdrawer stays OPERATOR_STATUS_UNKNOWN, so no schedule seats it",
        {},
        label,
        SysioOpregOperatorstatus.OPERATOR_STATUS_UNKNOWN
      )
    )

    ClusterBuildPhase.create(
      group,
      "ConsensusGuardPassesFirst",
      "A withdrawal requested as an economic epoch opens passes its consensus guard first and waits for its economic wait"
    ).push(
      WireEconomicClockTool.planAwaitEconomicEpochsOpened(
        Actor.BatchOperator,
        "economic-epoch-before-first-request",
        "an economic epoch opens, so the request's economic wait outlasts its consensus guard",
        nextEconomicEpochOptions,
        Constants.NextEconomicEpoch,
        Constants.ConsensusFirstObservation
      ),
      WireCollateralTool.planWithdrawal(
        Actor.BatchOperator,
        "withdraw-consensus-first",
        `withdraw ${Constants.WithdrawAmount} WIRE units of the bond`,
        SyndicationScenario.WriteOptions,
        label,
        WireCollateralTool.createWireCollateral(Constants.WithdrawAmount)
      ),
      EconomicClockSteps.planVerifyWithdrawalEligibility(
        Actor.Sysio,
        "consensus-first-eligibility",
        "the request is eligible two economic epochs and two consensus epochs after it",
        {},
        label,
        Constants.WithdrawAmount,
        Constants.ConsensusFirstObservation,
        Constants.ConsensusFirstWithdrawal
      ),
      EconomicClockSteps.planAwaitWithdrawalWaitPassed(
        Actor.Sysio,
        "consensus-guard-passes",
        "consensus reaches the request's eligible_at_consensus_epoch",
        {
          timeoutMs: EconomicClockSteps.withdrawalWaitStepTimeoutMs(
            config,
            WithdrawalWait.consensus
          )
        },
        label,
        Constants.ConsensusFirstWithdrawal,
        WithdrawalWait.consensus
      ),
      EconomicClockSteps.planVerifyWithdrawalHeld(
        Actor.Sysio,
        "held-by-economic-wait",
        "with only its consensus guard passed the request is still queued and nothing is credited",
        {},
        Constants.ConsensusFirstWithdrawal,
        WithdrawalWait.consensus,
        0n
      ),
      WireCollateralTool.planVerifyRemitClaim(
        Actor.Sysio,
        "consensus-first-matures",
        `remitclaims{withdrawer, WIRE} holds exactly ${Constants.WithdrawAmount}`,
        remitClaimStepOptions,
        label,
        WireCollateralTool.createWireClaim(Constants.WithdrawAmount)
      ),
      EconomicClockSteps.planVerifyWithdrawalMatured(
        Actor.Sysio,
        "consensus-first-flushed",
        "the request left the queue with both waits passed",
        {},
        label,
        Constants.ConsensusFirstWithdrawal
      )
    )

    ClusterBuildPhase.create(
      group,
      "EconomicWaitPassesFirst",
      "With consensus paused, a withdrawal's economic wait passes first and it waits for its consensus guard"
    ).push(
      Steps.contracts.sysio.epoch.planPause(
        Actor.Sysio,
        "pause-consensus",
        "governance pauses the consensus epoch through sysio.chalg@active, as an open dispute does",
        SyndicationScenario.WriteOptions
      ),
      WireEconomicClockTool.planRecordClockReading(
        Actor.Sysio,
        "record-paused-clocks",
        "record both clocks before the second request",
        {},
        Constants.EconomicFirstObservation
      ),
      WireCollateralTool.planWithdrawal(
        Actor.BatchOperator,
        "withdraw-economic-first",
        `withdraw another ${Constants.WithdrawAmount} WIRE units of the bond`,
        SyndicationScenario.WriteOptions,
        label,
        WireCollateralTool.createWireCollateral(Constants.WithdrawAmount)
      ),
      EconomicClockSteps.planVerifyWithdrawalEligibility(
        Actor.Sysio,
        "economic-first-eligibility",
        "the request is eligible two economic epochs and two consensus epochs after it",
        {},
        label,
        Constants.WithdrawAmount,
        Constants.EconomicFirstObservation,
        Constants.EconomicFirstWithdrawal
      ),
      EconomicClockSteps.planAwaitWithdrawalWaitPassed(
        Actor.BatchOperator,
        "economic-wait-passes",
        "the economic clock keeps opening epochs under the pause and reaches eligible_at_economic_epoch",
        {
          timeoutMs: EconomicClockSteps.withdrawalWaitStepTimeoutMs(
            config,
            WithdrawalWait.economic
          )
        },
        label,
        Constants.EconomicFirstWithdrawal,
        WithdrawalWait.economic
      ),
      EconomicClockSteps.planVerifyWithdrawalHeld(
        Actor.Sysio,
        "held-by-consensus-guard",
        "with only its economic wait passed the request is still queued and the claim holds only the first withdrawal",
        {},
        Constants.EconomicFirstWithdrawal,
        WithdrawalWait.economic,
        Constants.WithdrawAmount
      ),
      Steps.contracts.sysio.epoch.planUnpause(
        Actor.Sysio,
        "unpause-consensus",
        "governance clears the consensus pause",
        SyndicationScenario.WriteOptions
      ),
      WireCollateralTool.planVerifyRemitClaim(
        Actor.Sysio,
        "economic-first-matures",
        `remitclaims{withdrawer, WIRE} holds exactly ${Constants.MaturedClaimAmount}`,
        remitClaimStepOptions,
        label,
        WireCollateralTool.createWireClaim(Constants.MaturedClaimAmount)
      ),
      EconomicClockSteps.planVerifyWithdrawalMatured(
        Actor.Sysio,
        "economic-first-flushed",
        "the request left the queue with both waits passed",
        {},
        label,
        Constants.EconomicFirstWithdrawal
      )
    )
  }

  /** Phase group 3: a held payout leaves both clocks and OPP running, and pays once funded. */
  private planHeldEmissions(cluster: ClusterBuild): void {
    const { config } = cluster.context,
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "HeldEmissions",
        "Emissions held for want of spendable WIRE leave both clocks and OPP running; the refund pays the whole held period"
      ),
      nextEconomicEpochOptions = {
        timeoutMs: WireEconomicClockTool.awaitEconomicEpochsStepTimeoutMs(
          config.economicEpochDurationSec,
          Constants.NextEconomicEpoch
        )
      },
      emissionsWaitOptions = {
        timeoutMs: EconomicClockSteps.emissionsWaitStepTimeoutMs(
          config.economicEpochDurationSec
        )
      }

    ClusterBuildPhase.create(
      group,
      "DrainTreasury",
      "Move sysio's spendable WIRE to a holder at the start of an economic epoch"
    ).push(
      Steps.user.planProvisionWire(
        Actor.Sysio,
        "create-treasury-holder",
        `create ${Constants.TreasuryHolder} to hold the drained WIRE`,
        SyndicationScenario.WriteOptions,
        Constants.TreasuryHolder,
        0n
      ),
      WireEconomicClockTool.planAwaitEconomicEpochsOpened(
        Actor.BatchOperator,
        "economic-epoch-before-drain",
        "an economic epoch opens, so the drain lands well before the next pay epoch",
        nextEconomicEpochOptions,
        Constants.NextEconomicEpoch,
        Constants.DrainObservation
      ),
      EconomicClockSteps.planDrainSpendableWire(
        Actor.Sysio,
        "drain-spendable-wire",
        `move every unit of sysio's spendable WIRE to ${Constants.TreasuryHolder}`,
        SyndicationScenario.WriteOptions,
        Constants.TreasuryHolder
      ),
      EconomicClockSteps.planVerifySpendableWireDrained(
        Actor.Sysio,
        "spendable-wire-drained",
        "sysio's balance is no more than the pay it owes and the batch emission still settling",
        {}
      )
    )

    ClusterBuildPhase.create(
      group,
      "EmissionsHeld",
      "The readiness gate holds the pay epoch while both clocks and OPP keep running"
    ).push(
      EconomicClockSteps.planAwaitEmissionsHeld(
        Actor.Sysio,
        "emissions-held",
        "the next pay epoch is held: a BALANCE_INSUFFICIENT block episode opens in blocklog",
        emissionsWaitOptions,
        Constants.Hold
      ),
      EconomicClockSteps.planVerifyEmissionsHeld(
        Actor.Sysio,
        "held-balance-insufficient",
        "the gate attempted more than sysio could spend, the held epoch still accrued it, and nothing paid",
        {},
        Constants.Hold
      ),
      EconomicClockSteps.planAwaitEnvelopeRoundTrip(
        Actor.BatchOperator,
        "opp-round-trip-during-hold",
        "a depot envelope reaches each outpost and its answer reaches consensus on the depot during the hold",
        Constants.RoundTripOptions,
        Constants.Hold
      ),
      WireEconomicClockTool.planAwaitEconomicEpochsOpened(
        Actor.BatchOperator,
        "economic-epoch-during-hold",
        "the economic clock opens another epoch during the hold",
        nextEconomicEpochOptions,
        Constants.NextEconomicEpoch,
        Constants.HeldObservation
      ),
      EconomicClockSteps.planVerifyEmissionsHeldAcross(
        Actor.Sysio,
        "clocks-run-while-held",
        "the same episode holds every economic epoch since it opened, the period keeps accruing, and consensus advanced",
        {},
        Constants.Hold,
        Constants.HeldObservation
      )
    )

    ClusterBuildPhase.create(
      group,
      "RefundTreasury",
      "The refund lets the next economic epoch pay the whole held period"
    ).push(
      EconomicClockSteps.planRefundSpendableWire(
        Actor.Sysio,
        "refund-spendable-wire",
        `return the drained WIRE from ${Constants.TreasuryHolder} to sysio`,
        SyndicationScenario.WriteOptions,
        Constants.TreasuryHolder
      ),
      EconomicClockSteps.planAwaitEmissionsReleased(
        Actor.Sysio,
        "held-period-paid",
        "the next economic epoch pays the held period",
        emissionsWaitOptions,
        Constants.Hold,
        Constants.Release
      ),
      EconomicClockSteps.planVerifyEmissionsReleased(
        Actor.Sysio,
        "whole-period-paid",
        "the epochlog total is everything accrued while held plus the paying epoch's share, and the episode is closed",
        {},
        Constants.Hold,
        Constants.Release
      )
    )
  }

  /** Phase group 4: under the andon cord, emissions still pay and claimpay still succeeds. */
  private planAndonCord(cluster: ClusterBuild): void {
    const { config } = cluster.context,
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "AndonCord",
        "With the andon cord pulled, emissions still pay and the producer's claimpay still succeeds"
      )

    ClusterBuildPhase.create(
      group,
      "PullCord",
      "The panic account pulls the depot cord"
    ).push(
      Steps.contracts.sysio.andon.planPull(
        Actor.Sysio,
        "pull-cord",
        "the panic account pulls the depot cord",
        SyndicationScenario.WriteOptions,
        { reason: Constants.AndonReason }
      ),
      EconomicClockSteps.planVerifyCord(
        Actor.Sysio,
        "cord-pulled",
        "the cord is pulled",
        {},
        true
      )
    )

    ClusterBuildPhase.create(
      group,
      "EmissionsUnderCord",
      "An economic epoch pays while the cord is pulled"
    ).push(
      WireEconomicClockTool.planAwaitEconomicEpochsOpened(
        Actor.BatchOperator,
        "economic-epoch-under-cord",
        "the economic clock opens an epoch under the cord",
        {
          timeoutMs: WireEconomicClockTool.awaitEconomicEpochsStepTimeoutMs(
            config.economicEpochDurationSec,
            Constants.NextEconomicEpoch
          )
        },
        Constants.NextEconomicEpoch,
        Constants.CordObservation
      ),
      EconomicClockSteps.planVerifyEmissionsPaidPerEconomicEpoch(
        Actor.Sysio,
        "emissions-pay-under-cord",
        "the economic epoch paid its period into epochlog under the cord",
        {},
        Constants.CordObservation
      )
    )

    this.planClaimProducerPay(
      group,
      "ClaimUnderCord",
      "The producer's claimpay succeeds under the cord",
      Constants.CordPayClaim
    ).push(
      EconomicClockSteps.planVerifyCord(
        Actor.Sysio,
        "cord-still-pulled",
        "the cord was pulled throughout the claim",
        {},
        true
      )
    )

    ClusterBuildPhase.create(
      group,
      "ClearCord",
      "The panic account clears the depot cord"
    ).push(
      Steps.contracts.sysio.andon.planClear(
        Actor.Sysio,
        "clear-cord",
        "the panic account clears the depot cord",
        SyndicationScenario.WriteOptions,
        { note: Constants.AndonNote }
      ),
      EconomicClockSteps.planVerifyCord(
        Actor.Sysio,
        "cord-clear",
        "the cord is clear",
        {},
        false
      )
    )
  }

  /**
   * The producer's claim, as one Phase: record its liquid WIRE and credited pay, `claimpay`, and
   * verify it received the whole claim. Runs right after an economic epoch opens.
   *
   * @param group - The enclosing phase group.
   * @param name - The phase name.
   * @param description - The phase description.
   * @param snapshotName - The pay-claim snapshot's name.
   * @returns The self-registered phase.
   */
  private planClaimProducerPay(
    group: ClusterBuildPhaseGroup,
    name: string,
    description: string,
    snapshotName: string
  ): ClusterBuildPhase {
    return ClusterBuildPhase.create(group, name, description).push(
      EconomicClockSteps.planRecordPayClaim(
        Actor.Producer,
        `record-pay-${snapshotName}`,
        `record ${Constants.Producer}'s liquid WIRE and credited epoch pay`,
        {},
        Constants.Producer,
        snapshotName
      ),
      Steps.contracts.sysio.system.planClaimpay(
        Actor.Producer,
        `claimpay-${snapshotName}`,
        `${Constants.Producer} pulls its epoch pay through sysio.system::claimpay`,
        SyndicationScenario.WriteOptions,
        { account_name: Constants.Producer }
      ),
      EconomicClockSteps.planVerifyPayClaimPaid(
        Actor.Producer,
        `pay-received-${snapshotName}`,
        `${Constants.Producer}'s liquid WIRE rose by its whole claim`,
        {},
        Constants.Producer,
        snapshotName
      )
    )
  }
}
