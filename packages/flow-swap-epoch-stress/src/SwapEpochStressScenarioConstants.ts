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
  export const RequiredPostLoadEpochAdvances = 3
  export const PostLoadEpochBudget = 6
  export const SettlementDeadlineMs = ProtocolTiming.DoubleHopBudgetMs
  export const MsPerSecond = 1_000

  export function underwriterActiveDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      UnderwriterActiveEpochBudget *
      MsPerSecond
    )
  }

  export function postLoadEpochDeadlineMs(): number {
    return (
      ProtocolTiming.effectiveEpochSec(EpochDurationSec) *
      PostLoadEpochBudget *
      MsPerSecond
    )
  }
}
