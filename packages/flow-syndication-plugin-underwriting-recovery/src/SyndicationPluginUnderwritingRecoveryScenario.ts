import {
  BatchOperatorUnderwritingSteps as UnderwritingSteps,
  ClusterBuildPhase,
  ProtocolTiming,
  Report,
  SolanaLiqSyndicationTool,
  Steps,
  SyndicationScenario,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"

import { SyndicationPluginUnderwritingRecoveryScenarioConstants as Constants } from "./SyndicationPluginUnderwritingRecoveryScenarioConstants.js"
import { SyndicationPluginUnderwritingRecoverySteps as RecoverySteps } from "./steps/index.js"

const { Actor } = Report

/** A real underwriter catches up after its unobserved source digest is pruned. */
export class SyndicationPluginUnderwritingRecoveryScenario extends SyndicationScenario {
  /** Canonical flow-runner name. */
  readonly name = "flow-syndication-plugin-underwriting-recovery"
  /** The behavior recorded by the flow report. */
  readonly description = "Restart the sole funded underwriter after ten newer Solana envelopes replace its request's original digest"
  /** Nine relays form three groups of three, retaining majority during the provider's outage. */
  override readonly defaults: ClusterBuildOptions = {
    enableMockSyndicationImport: true,
    enableMockLiqPools: true,
    enableBatchOperatorUnderwriting: true,
    batchOperatorUnderwriting: { fundedOperatorCount: Constants.FundedOperatorCount },
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: 0
  }

  /**
   * Compose the outage, pruning proof and automatic underwriting recovery.
   * @param cluster - The ordinary bootstrap and scenario report tree.
   */
  plan(cluster: ClusterBuild): void {
    const { Plan } = Constants,
      node = RecoverySteps.fundedNode(cluster.context)
    this.planSetup(cluster, [Plan.user], null)
    UnderwritingSteps.planConfigureUnderwriting(cluster, Plan, Constants.Config, {
      phase: "Configure one funded underwriter and capture exact balances",
      configure: "use the ordinary fee, buckets and challenge window",
      funded: "only the first operator holds underwriting capital"
    })
    ClusterBuildPhase.create(cluster, "OfflineIntake", "The funded provider never observes the original source envelope").push(
      Steps.processes.nodeop.planStop(Actor.Underwriter, "stop-funded-underwriter",
        "stop and reap the funded operator before the user's syndication; retain its chain data and keys",
        SyndicationScenario.VerifyOptions, node.name),
      SolanaLiqSyndicationTool.planSynd(Actor.User, "delayed-syndication",
        "syndicate while only unfunded relays are running", SyndicationScenario.OutpostOptions,
        Plan.user.keypairName, Plan.amount),
      UnderwritingSteps.planVerifyRecorded(Actor.Sysio, "delayed-request-issued",
        "the live relays accept the envelope and issue its underwriting request",
        UnderwritingSteps.UnderwriterRequestIssuedOptions, Plan.amount, null, Plan.firstEpoch, Plan.firstRequest),
      verifyStep(Actor.Sysio, "original-digest-visible",
        "the finalized source digest equals the accepted row and the request has no bonds",
        RecoverySteps.verifyOriginal, SyndicationScenario.VerifyOptions),
      verifyStep(Actor.Sysio, "original-digest-pruned",
        "ten newer source records replace the original while its immutable request stays OPEN and unbonded",
        RecoverySteps.verifyPruned, {
          timeoutMs: Constants.pruningBudgetMs(cluster.context.config.outpostEpochDurationSec[SyndicationScenario.Chain]) + ProtocolTiming.PollDeadlineBufferMs
        }),
      verifyStep(Actor.Sysio, "pruning-evidence",
        "record the original request, ten retained newer epochs and matching checkpoint before recovery",
        RecoverySteps.verifyPruningEvidence, SyndicationScenario.VerifyOptions)
    )
    ClusterBuildPhase.create(cluster, "RecoverUnderwriter", "The same real plugin authenticates and settles the old request").push(
      Steps.processes.nodeop.planStart(Actor.Underwriter, "restart-original-underwriter",
        "resume the same node with retained data and signing keys after direct history is gone",
        SyndicationScenario.VerifyOptions, node.name),
      UnderwritingSteps.planVerifyBonded(Actor.Underwriter, "old-request-bonded",
        "the restarted plugin bonds the full old request using a newer checkpoint",
        SyndicationScenario.VerifyOptions, Plan, Plan.firstRequest),
      UnderwritingSteps.planVerifyApprovedAndClaimed(Actor.Underwriter, "old-request-approved-and-claimed",
        "the plugin approves after the normal challenge window and claims its principal",
        SyndicationScenario.VerifyOptions, Plan.firstRequest),
      verifyStep(Actor.Sysio, "exact-recovery-settlement",
        "the user receives the exact net, the fee pot retains only the fee and the provider recovers all capital",
        RecoverySteps.verifySettled, SyndicationScenario.VerifyOptions),
      UnderwritingSteps.planVerifyOperatorsActive(Actor.BatchOperator, "operators-active",
        "the live relays and the recovered bootstrap operator remain ACTIVE", SyndicationScenario.VerifyOptions)
    )
    this.planFinish(cluster)
  }
}
