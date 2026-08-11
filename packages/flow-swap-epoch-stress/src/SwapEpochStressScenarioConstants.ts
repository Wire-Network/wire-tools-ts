import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "@wireio/cluster-tool"

/** Fixed reproduction shape requested for the manual swap/epoch stress flow. */
export namespace SwapEpochStressScenarioConstants {
  export const ActorCount = 10
  export const ProducerCount = 21
  export const BatchOperatorCount = 21
  export const UnderwriterCount = 1
  export const EpochDurationSec = 60
  export const EthereumHdIndexBase = 32

  /** 0.01 ETH per actor; ten requests consume about 1% of the seeded book. */
  export const SourceEthereumWei = 10_000_000_000_000_000n
  export const WeiPerDepotUnit = 10n ** 9n
  export const ToleranceBps = 500
  export const UnderwriterMinimumBond = 1_000_000_000

  export const EthereumChainCode = SlugName.from("ETHEREUM")
  export const SolanaChainCode = SlugName.from("SOLANA")
  export const EthereumTokenCode = SlugName.from("ETH")
  export const SolanaTokenCode = SlugName.from("SOL")
  export const PrimaryReserveCode = SlugName.from("PRIMARY")
  export const ReserveManagerContractName = "ReserveManager"

  export const LongPollIntervalMs = 3_000
  export const PollDeadlineBufferMs = 30_000
  export const RequestStepTimeoutMs = 60_000
  export const UnderwriterActiveEpochBudget = 9
  /**
   * Post-load soak: crosses the ten-epoch envelope-retention and underwriting
   * lock windows, then observes five additional steady-state epochs.
   */
  export const RequiredPostLoadEpochAdvances = 15
  /** Missed effective-epoch windows tolerated before declaring a stall. */
  export const EpochAdvanceFailureBudget = ProtocolTiming.EpochVerifyEpochCount
  export const SettlementDeadlineMs = ProtocolTiming.DoubleHopBudgetMs
  export const MsPerSecond = 1_000

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
