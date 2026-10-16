import { ProtocolTiming } from "@wireio/cluster-tool"

/** Constants of the ethereum-go-live flow. */
export namespace EthereumGoLiveScenarioConstants {
  /** The depot's epoch duration; the default local cluster's. */
  export const EpochDurationSec = 60
  /** Three producers, three batch operators, no underwriters: the smallest live depot. */
  export const ProducerCount = 3
  export const BatchOperatorCount = 3
  export const UnderwriterCount = 0
  /** The shadow the frozen positions were imported as. */
  export const LiqTokenCodename = "LIQETH"
  /** The WIRE account the first frozen staker links its Ethereum key to. */
  export const StakerAccount = "ladder.stakr"
  /** The frozen staker whose position the flow sweeps: the first pre-launch actor. */
  export const SweptStakerIndex = 0
  /** The sweep is one depot action; poll it like any depot write. */
  export const SweepTimeoutMs = ProtocolTiming.OutpostWriteBudgetMs
  export const SweepPollMs = 2_000
  /** Per-step ceiling for the flow's writes. */
  export const WriteTimeoutMs = ProtocolTiming.OutpostWriteBudgetMs
}
