import { TokenAmount } from "@wireio/opp-typescript-models"
import {
  BatchOperatorUnderwritingSteps,
  OperatorDaemonTool,
  ProtocolTiming,
  SyndicationScenario
} from "@wireio/cluster-tool"

/** The syndications, the exhausting cap, the pair rules and typed cross-step state of the cap flow. */
export namespace SyndicationPluginUnderwritingCapScenarioConstants {
  /** The flow's syndications and recorded state, under the `pluginUnderwritingCap.` output keys. */
  export const Plan = BatchOperatorUnderwritingSteps.createPlan(
    "pluginUnderwritingCap"
  )
  /** The first request's covered amount: its amount rounded up to the bond increment. */
  export const FirstCovered = SyndicationScenario.coveredOf(Plan.amount)
  /** Batch operators the mock import funds: one, so it is the only possible bonder. */
  export const FundedOperatorCount = 1
  /** Producer/finalizer count used to budget the governance finality envelope. */
  export const ProducerCount = 3
  /**
   * The funded operator's LIQSOL exposure cap: exactly the first request's coverage, so the
   * first bond exhausts it and the second request can be bonded only once that bond is paid
   * back. The same cap heifner's flow-syndication-underwriting change (wire-tools-ts #120)
   * gave its standalone underwriter daemon.
   */
  export const UnderwriterExposureCap = TokenAmount.create({
    tokenCode: SyndicationScenario.TokenCode,
    amount: FirstCovered
  })
  /**
   * The challenge window this flow configures, in seconds: the first bond stays unpaid at
   * least this long, and inside it the flow must see the second request issued yet unbonded.
   * The post-bond envelope includes one scenario epoch for submission, a complete single
   * hop, governance irreversibility for the scenario's finalizers, two active plugin
   * passes (request issuance and reads), and one observer poll gap. A BONDED envelope
   * request keeps synd_has_work true, so the daemon cranks every active pass rather than
   * every 300 seconds; the generic 720-second issuance budget includes that idle fallback.
   * This is 589 seconds, leaving the three windows at 709 seconds, below the PR head's
   * 720 seconds. Step ceilings and timeout scaling never lengthen the on-chain window.
   * Only the first request uses this window; later requests use the ordinary pair rules.
   */
  export const ChallengeWindowSec = Math.ceil(
    SyndicationScenario.EpochDurationSec +
      (ProtocolTiming.SingleHopBudgetMs +
        ProtocolTiming.irreversibilityBudgetMs(ProducerCount) +
        2 * OperatorDaemonTool.BatchEpochPollMs +
        SyndicationScenario.PollMs) /
        ProtocolTiming.MsPerSecond
  )
  /** Pair-specific governance rules with {@link ChallengeWindowSec}, set in setup and restored at the end. */
  export const Config = BatchOperatorUnderwritingSteps.configOf(
    Plan,
    ChallengeWindowSec
  )
  /** Rules for requests issued after the first: retain the fee with the normal 60-second window. */
  export const LaterConfig = BatchOperatorUnderwritingSteps.configOf(Plan)
}
