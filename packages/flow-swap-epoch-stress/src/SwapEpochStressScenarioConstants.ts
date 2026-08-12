import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/cluster-tool"

/** Fixed load shape for the manual swap settlement and epoch-liveness flow. */
export namespace SwapEpochStressScenarioConstants {
  /** Number of independent Ethereum-to-Solana actor pairs. */
  export const ActorCount = 10
  /** Producer accounts used by the stress cluster. */
  export const ProducerCount = 21
  /** Batch operators used by the stress cluster. */
  export const BatchOperatorCount = 21
  /** Real underwriters bonded for both route legs. */
  export const UnderwriterCount = 1
  /** WIRE epoch duration used by this isolated flow cluster. */
  export const EpochDurationSec = 60
  /** First deterministic Anvil wallet index reserved for stress senders. */
  export const EthereumHdIndexBase = 32

  /** 0.01 ETH per actor; ten requests consume about 1% of the seeded book. */
  export const SourceEthereumWei = 10_000_000_000_000_000n
  /** Wei represented by one WIRE-side ETH reserve unit. */
  export const WeiPerDepotUnit = 10n ** 9n
  /** Maximum target-quote variance accepted by each request. */
  export const ToleranceBps = 500
  /** Minimum per-leg bond required from the stress underwriter. */
  export const UnderwriterMinimumBond = 1_000_000_000

  /** WIRE chain code for the source outpost. */
  export const EthereumChainCode = SlugName.from("ETHEREUM")
  /** WIRE chain code for the destination outpost. */
  export const SolanaChainCode = SlugName.from("SOLANA")
  /** Source reserve token code. */
  export const EthereumTokenCode = SlugName.from("ETH")
  /** Destination reserve token code. */
  export const SolanaTokenCode = SlugName.from("SOL")
  /** Public reserve selected on both route legs. */
  export const PrimaryReserveCode = SlugName.from("PRIMARY")
  /** Ethereum contract used to submit source-side swap requests. */
  export const ReserveManagerContractName = "ReserveManager"

  /** Poll interval for settlement and liveness reads. */
  export const LongPollIntervalMs = 3_000
  /** Extra wall-clock allowance outside an inner polling deadline. */
  export const PollDeadlineBufferMs = 30_000
  /** Per-request Ethereum transaction ceiling. */
  export const RequestStepTimeoutMs = 60_000
  /** Maximum number of aggregate-log evidence lines embedded in the report. */
  export const ClusterLogEvidenceSampleCount = 5
  /** Maximum characters retained from each aggregate-log evidence line. */
  export const ClusterLogEvidenceMaxLength = 1_000
  /** Epoch windows allowed for the underwriter to become active. */
  export const UnderwriterActiveEpochBudget = 9
  /**
   * Post-load soak: crosses the ten-epoch envelope-retention and underwriting
   * lock windows, then observes five additional steady-state epochs.
   */
  export const RequiredPostLoadEpochAdvances = 15
  /** Missed effective-epoch windows tolerated before declaring a stall. */
  export const EpochAdvanceFailureBudget = ProtocolTiming.EpochVerifyEpochCount
  /** End-to-end deadline for observing a destination remit. */
  export const SettlementDeadlineMs = ProtocolTiming.DoubleHopBudgetMs
  /** Milliseconds in one second. */
  export const MsPerSecond = 1_000

  /**
   * Calculate the underwriter activation deadline.
   *
   * @returns Extension-inclusive activation deadline in milliseconds.
   */
  export function underwriterActiveDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      UnderwriterActiveEpochBudget *
      MsPerSecond
    )
  }

  /**
   * Maximum time allowed for any single observed epoch advance.
   *
   * @returns Extension-inclusive epoch-stall deadline in milliseconds.
   */
  export function epochAdvanceDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      EpochAdvanceFailureBudget *
      MsPerSecond
    )
  }

  /**
   * Outer Step ceiling for the complete post-load epoch soak.
   *
   * @returns Extension-inclusive observation ceiling in milliseconds.
   */
  export function observationStepTimeoutMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      (RequiredPostLoadEpochAdvances + EpochAdvanceFailureBudget) *
      MsPerSecond
    )
  }
}
