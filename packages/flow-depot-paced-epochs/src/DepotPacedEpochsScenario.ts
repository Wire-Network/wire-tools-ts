import {
  OutpostChainCodename,
  OutpostChainCodenames
} from "@wireio/cluster-tool-shared"
import {
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  Constants as ClusterConstants,
  EthereumFundingTool,
  EthereumSyndicationTool,
  FlowScenario,
  NodeConfig,
  ProtocolTiming,
  Report,
  Steps,
  SyndicationScenario,
  SyndicationUserSteps,
  WireEconomicClockTool,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"

import { DepotPacedEpochsScenarioConstants as Constants } from "./DepotPacedEpochsScenarioConstants.js"
import { DepotPacedEpochsSteps } from "./steps/index.js"

const { Actor } = Report

/**
 * Each outpost chain's epochs are paced by the depot. Ethereum runs at a 60 s minimum and Solana at
 * 30 s, each with its default traffic wait and late window (half its minimum), nine bootstrapped
 * batch operators in three groups of three on each chain and the economic clock at 120 s. Three
 * phase groups each show their rules once, so a failure names its phase:
 *
 * 1. **IdleChainsStay** — with no traffic, over at least three of the longest minimum, no chain
 *    advances, takes traffic or ships an envelope and no outpost's inbound cursor moves, while the
 *    economic clock keeps opening epochs.
 * 2. **TrafficMakesDue** — a burst of three Ethereum syndications, reported as the outpost's
 *    backlog by a strict majority of the seats on duty, makes Ethereum due at the later of its
 *    epoch start plus its minimum and its oldest message plus its traffic wait; Ethereum advances
 *    then, once, all three syndications land in that one depot inbound epoch, and Solana does not
 *    move. A desyndication to Solana, queued on the depot, then makes Solana due the same way, and
 *    it advances no sooner than that while Ethereum does not move.
 * 3. **MajorityAndLateDelivery** — with one member of Ethereum's next group stopped, the depot
 *    decides that epoch at its second delivery, two of three seats; restarted once the next epoch
 *    opens, the member delivers the epoch late, inside its late window, and the books, which close
 *    once that window has passed with no advance, credit its delivery.
 */
export class DepotPacedEpochsScenario extends FlowScenario {
  readonly name = "flow-depot-paced-epochs"
  readonly description =
    "Each outpost chain's epochs are paced by the depot: an idle chain stays put, traffic makes it due, " +
    "a strict majority decides at once and a late delivery inside the window is credited"

  override readonly defaults: ClusterBuildOptions = {
    outpostEpochDurationSec: Constants.OutpostEpochDurationSec,
    economicEpochDurationSec: Constants.EconomicEpochDurationSec,
    batchOperatorCount: Constants.BatchOperatorCount,
    // The imported LIQSOL is what the redeemer desyndicates: the depot-queued traffic to Solana.
    enableMockSyndicationImport: true
  }

  plan(cluster: ClusterBuild): void {
    this.planIdleChainsStay(cluster)
    this.planTrafficMakesDue(cluster)
    this.planMajorityAndLateDelivery(cluster)
  }

  /** Phase group 1: with no traffic nothing moves, while the economic clock ticks. */
  private planIdleChainsStay(cluster: ClusterBuild): void {
    const { config } = cluster.context,
      idleEconomicEpochs = DepotPacedEpochsSteps.idleEconomicEpochs(config),
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "IdleChainsStay",
        "With no traffic no chain advances or ships an envelope and no outpost moves, " +
          "while the economic clock keeps opening epochs"
      )

    ClusterBuildPhase.create(group, "SettleIdle", "Every chain's epoch is decided and the chain idle").push(
      ...OutpostChainCodenames.map(chain =>
        DepotPacedEpochsSteps.planAwaitDecidedAndIdle(
          Actor.Sysio,
          `${chain.toLowerCase()}-decided-idle`,
          `the ${chain} epoch is decided and the chain idle`,
          ProtocolTiming.pollStepOptions(Steps.epochAdvance.epochAdvanceBudgetMs(config, chain)),
          chain
        )
      )
    )

    ClusterBuildPhase.create(
      group,
      "ObserveIdle",
      `Over ${idleEconomicEpochs} economic epochs, at least ${Constants.IdleWindowMinimums} of the longest ` +
        "minimum, nothing moves"
    ).push(
      DepotPacedEpochsSteps.planRecordOppStreams(
        Actor.Sysio,
        "record-idle-start",
        "record every chain's newest depot envelope and every outpost's inbound cursor",
        {},
        Constants.IdleStartStreams
      ),
      WireEconomicClockTool.planAwaitEconomicEpochsOpened(
        Actor.BatchOperator,
        "idle-window",
        `the relays' tickeconomy crank opens ${idleEconomicEpochs} economic epochs, no chain given traffic`,
        {
          timeoutMs: WireEconomicClockTool.awaitEconomicEpochsStepTimeoutMs(
            config.economicEpochDurationSec,
            idleEconomicEpochs
          )
        },
        idleEconomicEpochs,
        Constants.IdleWindowObservation
      ),
      DepotPacedEpochsSteps.planRecordOppStreams(
        Actor.Sysio,
        "record-idle-end",
        "record every chain's newest depot envelope and every outpost's inbound cursor again",
        {},
        Constants.IdleEndStreams
      ),
      DepotPacedEpochsSteps.planVerifyIdle(
        Actor.Sysio,
        "idle-chains-stay",
        "every chain stayed at its decided epoch with no traffic, no envelope was built and no outpost " +
          "cursor moved, while economic epochs opened",
        {},
        Constants.IdleWindowObservation,
        Constants.IdleStartStreams,
        Constants.IdleEndStreams
      )
    )
  }

  /** Phase group 2: traffic from either side makes its chain due, and only that chain advances. */
  private planTrafficMakesDue(cluster: ClusterBuild): void {
    const { config } = cluster.context,
      ethereum = OutpostChainCodename.ETHEREUM,
      solana = OutpostChainCodename.SOLANA,
      ethereumSec = config.outpostEpochDurationSec[ethereum],
      solanaSec = config.outpostEpochDurationSec[solana],
      burstWei = BigInt(Constants.SyndicationCount) * Constants.SyndicationAmountWei,
      depositWei = burstWei + Constants.DepositHeadroomWei,
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "TrafficMakesDue",
        "A message from an outpost or from the depot makes its chain due after its minimum and its traffic " +
          "wait; that chain alone advances"
      )

    ClusterBuildPhase.create(
      group,
      "PrepareHolders",
      "An Ethereum holder with liqETH to syndicate, and a WIRE redeemer holding the imported LIQSOL"
    ).push(
      EthereumFundingTool.planCreateWallet(
        Actor.User,
        "create-holder-wallet",
        "generate the holder's Ethereum wallet",
        SyndicationScenario.WriteOptions,
        Constants.HolderWalletName,
        "depot-paced epochs — holder wallet"
      ),
      EthereumFundingTool.planSetBalance(
        Actor.User,
        "fund-holder-wallet",
        "fund the holder's wallet for the deposit and its gas",
        SyndicationScenario.OutpostOptions,
        Constants.HolderWalletName,
        depositWei + Constants.HolderGasWei
      ),
      EthereumSyndicationTool.planDepositLiqEth(
        Actor.User,
        "deposit-eth",
        "deposit ETH for the burst's liqETH, with one syndication of headroom for the liqETH rate",
        SyndicationScenario.OutpostOptions,
        Constants.HolderWalletName,
        depositWei
      ),
      EthereumSyndicationTool.planApproveLiqEth(
        Actor.User,
        "approve-pool",
        "allow the syndication pool to custody the burst",
        SyndicationScenario.OutpostOptions,
        Constants.HolderWalletName,
        burstWei
      ),
      Steps.account.planCreateKeyed(
        Actor.User,
        "create-redeemer",
        "create the redeemer's WIRE account",
        SyndicationScenario.WriteOptions,
        Constants.RedeemerAccount,
        ClusterConstants.DEV_K1_PUBLIC_KEY
      ),
      SyndicationUserSteps.planLinkSolanaKey(
        Actor.User,
        "link-redeemer",
        "link the imported position's Solana key, which delivers its LIQSOL to the redeemer",
        SyndicationScenario.WriteOptions,
        Constants.RedeemerAccount,
        Steps.registry.MockSyndicationBonderLabel
      )
    )

    ClusterBuildPhase.create(
      group,
      "EthereumBurst",
      `${Constants.SyndicationCount} Ethereum syndications make Ethereum due once; it advances on time and ` +
        "Solana does not"
    ).push(
      Steps.epochAdvance.planRecordEpochIndices(
        Actor.Sysio,
        "record-before-ethereum",
        "record every chain's epoch index before the burst",
        {},
        Constants.BeforeEthereumTraffic
      ),
      ...Array.from({ length: Constants.SyndicationCount }, (_, index) =>
        EthereumSyndicationTool.planSyndicate(
          Actor.User,
          `syndicate-${index + 1}`,
          `syndicate ${Constants.SyndicationAmountWei} liqETH wei, message ${index + 1} of the burst`,
          SyndicationScenario.OutpostOptions,
          Constants.HolderWalletName,
          Constants.SyndicationAmountWei
        )
      ),
      DepotPacedEpochsSteps.planAwaitChainDue(
        Actor.Sysio,
        "ethereum-due",
        `Ethereum is due at the later of its start plus ${ethereumSec} s and its oldest message plus its traffic wait`,
        ProtocolTiming.pollStepOptions(
          ProtocolTiming.effectiveEpochsMs(ethereumSec, Constants.DueBudgetEpochs)
        ),
        ethereum
      ),
      DepotPacedEpochsSteps.planVerifyBacklogReports(
        Actor.BatchOperator,
        "ethereum-backlog-reported",
        "a strict majority of the seats on duty reported the outpost's backlog, dated by its oldest message",
        {},
        ethereum
      ),
      DepotPacedEpochsSteps.planAwaitDueAdvance(
        Actor.Sysio,
        "ethereum-advances-when-due",
        "Ethereum advances once, no sooner than due and within a relay poll and two blocks of it; Solana does not move",
        ProtocolTiming.pollStepOptions(
          ProtocolTiming.effectiveEpochsMs(ethereumSec, Constants.AdvanceBudgetEpochs)
        ),
        ethereum,
        Constants.BeforeEthereumTraffic
      ),
      DepotPacedEpochsSteps.planAwaitDecidedAndIdle(
        Actor.Sysio,
        "ethereum-idle-again",
        "the new Ethereum epoch is decided and the chain idle again",
        ProtocolTiming.pollStepOptions(Steps.epochAdvance.epochAdvanceBudgetMs(config, ethereum)),
        ethereum
      ),
      DepotPacedEpochsSteps.planVerifyBurstInOneEpoch(
        Actor.Sysio,
        "burst-in-one-epoch",
        `all ${Constants.SyndicationCount} syndications landed in the one depot inbound epoch, ` +
          "and Ethereum advanced once",
        {},
        Constants.HolderWalletName,
        Constants.SyndicationCount
      )
    )

    ClusterBuildPhase.create(
      group,
      "SolanaDesyndication",
      "A desyndication queued to Solana makes Solana due; it advances no sooner than due and Ethereum does not move"
    ).push(
      Steps.epochAdvance.planRecordEpochIndices(
        Actor.Sysio,
        "record-before-solana",
        "record every chain's epoch index before the desyndication",
        {},
        Constants.BeforeSolanaTraffic
      ),
      Steps.contracts.sysio.synd.planDesyndicate(
        Actor.User,
        "desyndicate-liqsol",
        "desyndicate LIQSOL to Solana: sysio.msgch::queueout gives Solana traffic",
        SyndicationScenario.WriteOptions,
        {
          holder: Constants.RedeemerAccount,
          quantity: SyndicationScenario.quantity(Constants.DesyndicationAmount)
        }
      ),
      DepotPacedEpochsSteps.planAwaitChainDue(
        Actor.Sysio,
        "solana-due",
        `Solana is due at the later of its start plus ${solanaSec} s and the queued message plus its traffic wait`,
        ProtocolTiming.pollStepOptions(
          ProtocolTiming.effectiveEpochsMs(solanaSec, Constants.DueBudgetEpochs)
        ),
        solana
      ),
      DepotPacedEpochsSteps.planAwaitDueAdvance(
        Actor.Sysio,
        "solana-advances-when-due",
        "Solana advances once, no sooner than due and within a relay poll and two blocks of it; Ethereum does not move",
        ProtocolTiming.pollStepOptions(
          ProtocolTiming.effectiveEpochsMs(solanaSec, Constants.AdvanceBudgetEpochs)
        ),
        solana,
        Constants.BeforeSolanaTraffic
      )
    )
  }

  /** Phase group 3: a strict majority decides at once, and a late delivery in the window is credited. */
  private planMajorityAndLateDelivery(cluster: ClusterBuild): void {
    const { config } = cluster.context,
      chain = OutpostChainCodename.ETHEREUM,
      minimumSec = config.outpostEpochDurationSec[chain],
      [member] = NodeConfig.batchOperatorNodes(config),
      label = member.batchOperatorLabel,
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "MajorityAndLateDelivery",
        `With one member of ${chain}'s next group stopped, two of three seats decide the epoch at once; ` +
          "the member, restarted inside the late window, is credited"
      )

    ClusterBuildPhase.create(
      group,
      "StopMember",
      `Stop the relay of ${label}, a member of the ${chain} group on duty next`
    ).push(
      DepotPacedEpochsSteps.planAwaitMemberNextOnDuty(
        Actor.Sysio,
        "member-next-on-duty",
        `kept due, ${chain} comes to a decided epoch whose next group seats ${label}, its advance a relay stop away`,
        ProtocolTiming.pollStepOptions(
          ProtocolTiming.effectiveEpochsMs(minimumSec, Constants.NextOnDutyBudgetEpochs)
        ),
        chain,
        label
      ),
      Steps.processes.nodeop.planStop(
        Actor.BatchOperator,
        "stop-member-relay",
        `stop and reap ${member.name} (${label}), retaining its data`,
        SyndicationScenario.VerifyOptions,
        member.name
      )
    )

    ClusterBuildPhase.create(
      group,
      "MajorityDecides",
      "Kept due, the member's epoch is decided by two of its three seats at the second delivery"
    ).push(
      DepotPacedEpochsSteps.planAwaitMajorityDecision(
        Actor.BatchOperator,
        "majority-decides",
        `the depot accepts the ${chain} epoch at its second delivery, ${label} absent`,
        ProtocolTiming.pollStepOptions(
          ProtocolTiming.effectiveEpochsMs(minimumSec, Constants.MajorityBudgetEpochs)
        ),
        chain,
        label
      )
    )

    ClusterBuildPhase.create(
      group,
      "LateDeliveryCredited",
      "Restarted once the next epoch opens, the member delivers its epoch inside the late window, " +
        "and the books, closed once the window has passed with no advance, credit it"
    ).push(
      DepotPacedEpochsSteps.planAwaitNextEpochOpened(
        Actor.Sysio,
        "next-epoch-opens",
        `kept due, the ${chain} epoch after the member's opens, which opens its late window`,
        ProtocolTiming.pollStepOptions(
          ProtocolTiming.effectiveEpochsMs(minimumSec, Constants.NextEpochBudgetEpochs)
        ),
        chain
      ),
      Steps.processes.nodeop.planStart(
        Actor.BatchOperator,
        "restart-member-relay",
        `relaunch ${member.name} (${label}) with its retained data and keys`,
        SyndicationScenario.VerifyOptions,
        member.name
      ),
      DepotPacedEpochsSteps.planAwaitLateDelivery(
        Actor.BatchOperator,
        "late-delivery",
        `${label} delivers its ${chain} epoch late: the accepted envelope's bytes, inside the late window`,
        ProtocolTiming.pollStepOptions(
          ProtocolTiming.effectiveEpochsMs(minimumSec, Constants.LateDeliveryBudgetEpochs)
        ),
        chain,
        label
      ),
      DepotPacedEpochsSteps.planAwaitDeliveryCredited(
        Actor.Sysio,
        "books-credit-member",
        `once the late window has passed, the relays' chkcons closes the epoch's books with no advance, ` +
          `recording ${label}'s delivery, not a miss`,
        ProtocolTiming.pollStepOptions(
          ProtocolTiming.effectiveEpochsMs(minimumSec, Constants.BooksClosingBudgetEpochs)
        ),
        chain,
        label
      )
    )
  }
}
