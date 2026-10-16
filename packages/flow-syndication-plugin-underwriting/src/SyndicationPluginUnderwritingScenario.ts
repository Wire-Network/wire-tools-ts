import {
  ClusterBuildPhase,
  Report,
  BatchOperatorUnderwritingSteps as UnderwritingSteps,
  SolanaLiqSyndicationTool,
  SyndicationScenario,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { SyndicationPluginUnderwritingScenarioConstants as Constants } from "./SyndicationPluginUnderwritingScenarioConstants.js"

const { Actor } = Report

/**
 * Prove the batch_operator_plugin's underwriter role, configured properly, underwrites
 * syndication with no intervention: the cluster's batch operators run the role and hold an
 * imported LIQSOL credit from bootstrap, the pair is configured in setup, and from then on the
 * flow only acts as users — two syndications, an unlinked recipient's syndication and its
 * `createlink`. Every bond, crank, approval and claim is the operators'; the flow only waits
 * for each and checks the exact accounting.
 */
export class SyndicationPluginUnderwritingScenario extends SyndicationScenario {
  readonly name = "flow-syndication-plugin-underwriting"
  readonly description =
    "Batch operators underwrite held syndications on their own: bonded, released with fees, approved and claimed; parked credit is linked"
  override readonly defaults: ClusterBuildOptions = {
    enableMockSyndicationImport: true,
    enableMockLiqPools: true,
    enableBatchOperatorUnderwriting: true,
    epochDurationSec: SyndicationScenario.EpochDurationSec,
    producerCount: 3,
    batchOperatorCount: 3,
    underwriterCount: 0
  }

  plan(cluster: ClusterBuild): void {
    const plan = Constants.Plan
    // No flow-side bond provider: the batch operators bond from their bootstrap credits.
    this.planSetup(cluster, [plan.user, plan.unlinked], null)
    UnderwritingSteps.planConfigureUnderwriting(
      cluster,
      plan,
      Constants.Config,
      {
        phase:
          "Set the pair rules; every batch operator holds its underwriting credit",
        configure: "enable the scenario fee and buckets",
        funded:
          "each batch operator holds exactly its imported LIQSOL; record the balances"
      }
    )
    ClusterBuildPhase.create(
      cluster,
      "Syndicate",
      "The linked user syndicates twice; each request is bonded by the operators in turn"
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
      // Right after the request: its bond rows exist until the bond is paid, which the
      // challenge window holds back for at least window_sec.
      UnderwritingSteps.planVerifyBonded(
        Actor.Underwriter,
        "first-bonded",
        "batch operators bond the first request's whole coverage within their caps",
        SyndicationScenario.VerifyOptions,
        plan,
        plan.firstRequest
      ),
      UnderwritingSteps.planVerifyFirstCoveredCustody(
        Actor.Sysio,
        "first-covered-custody",
        "coverage rounds up, the attestation is persisted and the newest total_syndicated equals custody",
        SyndicationScenario.VerifyOptions,
        plan
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "second-syndication",
        "syndicate again",
        SyndicationScenario.OutpostOptions,
        plan.user.keypairName,
        plan.laterAmount
      ),
      UnderwritingSteps.planVerifyRecorded(
        Actor.Sysio,
        "second-requested",
        "a later envelope has an issued request",
        UnderwritingSteps.UnderwriterRequestIssuedOptions,
        plan.laterAmount,
        plan.firstEpoch,
        plan.secondEpoch,
        plan.secondRequest
      ),
      UnderwritingSteps.planVerifyBonded(
        Actor.Underwriter,
        "second-bonded",
        "batch operators bond the second request's whole coverage within their caps",
        SyndicationScenario.VerifyOptions,
        plan,
        plan.secondRequest
      ),
      UnderwritingSteps.planVerifySecondCoveredCustody(
        Actor.Sysio,
        "second-covered-custody",
        "coverage rounds up, total_syndicated grows by exactly the second syndication plus yield, and equals custody",
        SyndicationScenario.VerifyOptions,
        plan
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "Release",
      "The operators' cranks release each envelope net of its fee, in queue order"
    ).push(
      UnderwritingSteps.planVerifyFirstRelease(
        Actor.Sysio,
        "first-released",
        "exact fee and linked credit",
        SyndicationScenario.VerifyOptions,
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
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "Approve",
      "After each challenge window the operators approve and claim"
    ).push(
      UnderwritingSteps.planVerifyApprovedAndClaimed(
        Actor.Underwriter,
        "first-approved-and-claimed",
        "first request APPROVED after its window and its bonds paid back",
        SyndicationScenario.VerifyOptions,
        plan.firstRequest
      ),
      UnderwritingSteps.planVerifyApprovedAndClaimed(
        Actor.Underwriter,
        "second-approved-and-claimed",
        "second request APPROVED after its window and its bonds paid back",
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
