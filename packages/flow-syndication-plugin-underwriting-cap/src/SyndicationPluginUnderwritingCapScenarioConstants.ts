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
   * Epochs of emitted outbound envelopes the Solana outpost keeps on chain, mirroring
   * `MAX_TRACKED_ENVELOPES` in wire-solana's `liqsol-core/src/states/opp_states.rs`. The
   * underwriter verifies a request's statement against that log, so a request whose epoch
   * has left it can never be bonded.
   */
  export const SolanaRetainedEnvelopeEpochs = 10
  /** Underwriter passes from the end of the first bond's window to the second bond: approve, claim, bond. */
  export const PaybackPassCount = 3
  /** Whole epochs the second request's statement still has in the Solana log when it is bonded. */
  export const RetentionHeadroomEpochs = 1
  /**
   * The first challenge window less its submission epoch, in seconds: a complete single
   * hop, governance irreversibility for the scenario's finalizers, two active plugin passes
   * (request issuance and reads) and one observer poll gap. A BONDED envelope request keeps
   * synd_has_work true, so the daemon cranks every active pass, not every 300 seconds.
   */
  export const ChallengeWindowFixedSec = Math.ceil(
    (ProtocolTiming.SingleHopBudgetMs +
      ProtocolTiming.irreversibilityBudgetMs(ProducerCount) +
      2 * OperatorDaemonTool.BatchEpochPollMs +
      SyndicationScenario.PollMs) /
      ProtocolTiming.MsPerSecond
  )
  /**
   * The flow's epoch, in seconds: the shortest at which the second request is still
   * verifiable when the first bond is paid back. The payback lands a challenge window plus
   * {@link PaybackPassCount} passes after the first bond, and the second request's statement
   * is no older than that bond, so the window, the passes and
   * {@link RetentionHeadroomEpochs} must fit inside {@link SolanaRetainedEnvelopeEpochs}
   * epochs. At the 60-second shortest depot epoch they do not, since the window is itself
   * about ten epochs long. An epoch that runs longer than this only widens the margin: the
   * log keeps a count of epochs, not a span of time.
   */
  export const EpochDurationSec = Math.ceil(
    (ChallengeWindowFixedSec +
      (PaybackPassCount * OperatorDaemonTool.BatchEpochPollMs) /
        ProtocolTiming.MsPerSecond) /
      (SolanaRetainedEnvelopeEpochs - 1 - RetentionHeadroomEpochs)
  )
  /**
   * The challenge window this flow configures, in seconds: one scenario epoch for
   * submission plus {@link ChallengeWindowFixedSec}. The first bond stays unpaid at least
   * this long, and inside it the flow must see the second request issued yet unbonded.
   * Step ceilings and timeout scaling never lengthen the on-chain window. Only the first
   * request uses it; later requests use the ordinary pair rules.
   */
  export const ChallengeWindowSec = EpochDurationSec + ChallengeWindowFixedSec
  /** Pair-specific governance rules with {@link ChallengeWindowSec}, set in setup and restored at the end. */
  export const Config = BatchOperatorUnderwritingSteps.configOf(
    Plan,
    ChallengeWindowSec
  )
  /** Rules for requests issued after the first: retain the fee with the normal 60-second window. */
  export const LaterConfig = BatchOperatorUnderwritingSteps.configOf(Plan)
}
