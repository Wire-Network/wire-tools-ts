import { ProtocolTiming, SolanaLiqSyndicationTool } from "@wireio/cluster-tool"

/** Controlled positions and protocol timing of the Solana genesis snapshot flow. */
export namespace SolanaGenesisSnapshotConstants {
  /** The external implementation under test; its standalone exporter must already be built. */
  export const CapitalIndexPathEnvironment = "WIRE_CAPITAL_INDEX_PATH"
  /** Minimum live depot topology, independent of the Solana accounting under test. */
  export const EpochDurationSec = 60
  /** Leave room for transaction finality and the first export inside the purchase epoch. */
  export const SolanaSlotsPerEpoch = 256
  export const ProducerCount = 3
  export const BatchOperatorCount = 3
  export const UnderwriterCount = 0
  /** Durable keypair labels for the mixed-position owner and the fully exited staker. */
  export const ActiveUser = "genesis-active"
  export const ExitedUser = "genesis-exited"
  /** SOL/liqSOL base units: real deposits leave fee and transaction headroom. */
  export const UserFloorLamports = 20_000_000_000n
  export const DepositLamports = 5_000_000_000n
  export const ActiveStake = 2_000_000_000n
  export const ExitedStake = 1_000_000_000n
  export const PurchaseAmount = 1_000_000_000n
  /** Each real bonus donation is a protocol-valid multiple of 0.1 SOL. */
  export const BonusYieldLamports =
    3n * SolanaLiqSyndicationTool.BonusYieldLamportGranularity
  /** Local writes/exports and epoch predicates use the harness timing envelope. */
  export const WriteTimeoutMs = ProtocolTiming.OutpostWriteBudgetMs
  export const EpochTimeoutMs = ProtocolTiming.SingleHopBudgetMs
  export const PollIntervalMs = ProtocolTiming.EpochVerifyPollIntervalMs
  /** Solana transaction compute budget, shared with the real syndication tool. */
  export const ComputeUnitLimit =
    SolanaLiqSyndicationTool.SyndicationComputeUnitLimit
  /** Persisted external-process artifacts below this flow's cluster directory. */
  export const ArtifactDirectory = "solana-genesis-snapshot"
  export const FirstExportFile = "genesis-immediate.json"
  export const LaterExportFile = "genesis-later-epoch.json"
  export const RefusedExportFile = "genesis-prelaunch-refused.json"
  /** Child diagnostics are bounded; JSON is read from its artifact, not stdout. */
  export const ProcessMaxBuffer = 4 * 1024 * 1024
}
