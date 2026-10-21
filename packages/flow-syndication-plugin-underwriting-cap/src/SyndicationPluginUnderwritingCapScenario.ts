import {
  BatchOperatorUnderwritingSteps as UnderwritingSteps,
  ClusterBuildPhase,
  ProtocolTiming,
  Report,
  SolanaLiqSyndicationTool,
  Steps,
  SyndicationScenario,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { SyndicationPluginUnderwritingCapScenarioConstants as Constants } from "./SyndicationPluginUnderwritingCapScenarioConstants.js"
import { SyndicationPluginUnderwritingCapSteps as CapSteps } from "./steps/index.js"

const { Actor } = Report

/**
 * Prove the batch_operator_plugin underwriter role's exposure cap is enforced and recovers:
 * every batch operator runs the role, but only one is funded and its cap is exactly the first
 * request's coverage. Its first bond exhausts the cap, so the second request is issued yet
 * held unbonded until that bond is approved and claimed; then the same operator bonds it.
 * Governance restores the ordinary window after the first request is issued; the flow
 * then acts only as users and waits for every operator effect.
 */
export class SyndicationPluginUnderwritingCapScenario extends SyndicationScenario {
  readonly name = "flow-syndication-plugin-underwriting-cap"
  readonly description =
    "One funded batch operator's exposure cap holds the second request until its first bond is paid; then it bonds, approves and claims"
  override readonly defaults: ClusterBuildOptions = {
    enableMockSyndicationImport: true,
    enableMockLiqPools: true,
    enableBatchOperatorUnderwriting: true,
    batchOperatorUnderwriting: {
      fundedOperatorCount: Constants.FundedOperatorCount,
      maxExposure: [Constants.UnderwriterExposureCap]
    },
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: 3,
    underwriterCount: 0
  }

  plan(cluster: ClusterBuild): void {
    const plan = Constants.Plan
    // No flow-side bond provider: the one funded batch operator bonds from its bootstrap credit.
    this.planSetup(cluster, [plan.user, plan.unlinked], null)
    UnderwritingSteps.planConfigureUnderwriting(
      cluster,
      plan,
      Constants.Config,
      {
        phase:
          "Set the pair rules; only the funded operator holds an underwriting credit",
        configure:
          "enable the scenario fee, buckets and the cap-observation challenge window",
        funded:
          "the funded operator holds exactly its imported LIQSOL, the others nothing; record the balances"
      }
    )
    ClusterBuildPhase.create(
      cluster,
      "ExhaustCap",
      "The first bond exhausts the cap; the second request is issued but held"
    ).push(
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "first-syndication",
        "syndicate the non-rounded amount",
        SyndicationScenario.OutpostOptions,
        plan.user.keypairName,
        plan.amount
      ),
      UnderwritingSteps.planVerifyRecorded(
        Actor.Sysio,
        "first-requested",
        "the first envelope has an issued request",
        UnderwritingSteps.UnderwriterRequestIssuedOptions,
        plan.amount,
        null,
        plan.firstEpoch,
        plan.firstRequest
      ),
      // Requests snapshot window_sec at issuance. Keep the observation window on the first.
      Steps.contracts.sysio.synd.planSetconfig(
        Actor.Sysio,
        "configure-later-requests",
        "use the ordinary challenge window for later requests; the first retains its saved window",
        {
          timeoutMs:
            ProtocolTiming.irreversibilityBudgetMs(Constants.ProducerCount) +
            ProtocolTiming.PollDeadlineBufferMs
        },
        Constants.LaterConfig
      ),
      UnderwritingSteps.planVerifyBonded(
        Actor.Underwriter,
        "first-bonded",
        "the funded operator bonds the first request's whole coverage, exhausting its cap",
        SyndicationScenario.VerifyOptions,
        plan,
        plan.firstRequest
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "SecondIntake",
      "Observe the held request from before the second syndication is submitted",
      [],
      { parallelize: true }
    ).push(
      CapSteps.planVerifySecondRequested(
        Actor.Sysio,
        "second-requested",
        "capture the later request's held state as soon as its envelope has an issued request",
        UnderwritingSteps.UnderwriterRequestIssuedOptions,
        plan
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "second-syndication",
        "syndicate again while the cap is exhausted",
        SyndicationScenario.OutpostOptions,
        plan.user.keypairName,
        plan.laterAmount
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "ObserveCap",
      "Continue the intake observation until payment, then verify custody and release"
    ).push(
      CapSteps.planVerifySecondHeldByCap(
        Actor.Underwriter,
        "second-held-by-cap",
        "on every reading until the first bond is paid, the second request is OPEN with nothing bonded and no bond row",
        CapSteps.heldOptions(Constants.ChallengeWindowSec),
        plan,
        Constants.ChallengeWindowSec
      ),
      UnderwritingSteps.planVerifyFirstCoveredCustody(
        Actor.Sysio,
        "first-covered-custody",
        "coverage rounds up, the attestation is persisted and the newest total_syndicated equals custody",
        SyndicationScenario.VerifyOptions,
        plan
      ),
      UnderwritingSteps.planVerifySecondCoveredCustody(
        Actor.Sysio,
        "second-covered-custody",
        "coverage rounds up, total_syndicated grows by exactly the second syndication plus yield, and equals custody",
        SyndicationScenario.VerifyOptions,
        plan
      ),
      UnderwritingSteps.planVerifyFirstRelease(
        Actor.Sysio,
        "first-released",
        "exact fee and linked credit, including any second release after cap recovery",
        SyndicationScenario.VerifyOptions,
        plan
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "RecoverCap",
      "Approving and claiming the first bond frees the cap; the same operator bonds the second"
    ).push(
      UnderwritingSteps.planVerifyApprovedAndClaimed(
        Actor.Underwriter,
        "first-approved-and-claimed",
        "first request APPROVED after its window and its bond paid back",
        SyndicationScenario.VerifyOptions,
        plan.firstRequest
      ),
      UnderwritingSteps.planVerifyBonded(
        Actor.Underwriter,
        "second-bonded",
        "the funded operator bonds the second request's whole coverage",
        SyndicationScenario.VerifyOptions,
        plan,
        plan.secondRequest
      ),
      CapSteps.planVerifyBondedAfterRecovery(
        Actor.Sysio,
        "second-bonded-after-recovery",
        "the first bond is paid, the operator's liquid LIQSOL plus its second stake is its funded balance, and the second was bonded no earlier than the first was approved",
        {},
        plan
      ),
      UnderwritingSteps.planVerifySecondDrained(
        Actor.Sysio,
        "second-drained",
        "both nets credited and both fees collected",
        SyndicationScenario.VerifyOptions,
        plan
      ),
      UnderwritingSteps.planVerifyQueueOrder(
        Actor.Sysio,
        "queue-order",
        "the second request was issued only after the first was bonded",
        {},
        plan
      ),
      UnderwritingSteps.planVerifyApprovedAndClaimed(
        Actor.Underwriter,
        "second-approved-and-claimed",
        "second request APPROVED after its window and its bond paid back",
        SyndicationScenario.VerifyOptions,
        plan.secondRequest
      )
    )
    UnderwritingSteps.planUnlinkedIntake(cluster, plan)
    UnderwritingSteps.planParkAndLink(cluster, plan)
    UnderwritingSteps.planSettle(cluster, plan)
    this.planFinish(cluster)
  }
}
