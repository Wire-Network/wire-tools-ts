import { BatchOperatorUnderwritingSteps, ProtocolTiming, SyndicationScenario } from "@wireio/cluster-tool"

/** Protocol timing and immutable inputs of the recovery experiment. */
export namespace SyndicationPluginUnderwritingRecoveryScenarioConstants {
  /** One delayed Solana intake, with shared exact-accounting output keys. */
  export const Plan = BatchOperatorUnderwritingSteps.createPlan("pluginUnderwritingRecovery")
  /** Pair rules: a nonzero fee, no bounty and the ordinary challenge window. */
  export const Config = BatchOperatorUnderwritingSteps.configOf(Plan)
  /** The one funded provider is taken offline; the other members of its group retain majority. */
  export const FundedOperatorCount = 1
  /** Three live finalizers retain irreversible depot execution during the outage. */
  export const ProducerCount = 3
  /** Three groups of three keep every rotation live while one bootstrap relay is offline. */
  export const BatchOperatorCount = 9
  /** Extra epochs cover checkpoint finalization after the ten-record window moves. */
  export const CheckpointHeadroomEpochs = 3
  /**
   * Poll budget for real pruning and a matching accepted checkpoint.
   * @param epochDurationSec - The Solana chain's actual consensus epoch duration: its envelope
   *   log prunes one record per Solana epoch.
   * @returns The retention window plus finalization headroom in milliseconds.
   */
  export function pruningBudgetMs(epochDurationSec: number): number {
    return (BatchOperatorUnderwritingSteps.SolanaRetainedEnvelopeEpochs + CheckpointHeadroomEpochs) *
      ProtocolTiming.effectiveEpochSec(epochDurationSec) * ProtocolTiming.MsPerSecond
  }
  /** Pruning changes once per epoch; five-second reads avoid flooding the RPC endpoints. */
  export const PruningPollMs = 5 * ProtocolTiming.MsPerSecond
  /** Anchor's generated account name, decoded with the deployed program's own IDL. */
  export const EnvelopeLogAccountName = "envelopeLog"
  /** Every outpost chain's consensus epoch keeps the experiment at ordinary one-minute cadence. */
  export const EpochDurationSec = SyndicationScenario.EpochDurationSec
}
