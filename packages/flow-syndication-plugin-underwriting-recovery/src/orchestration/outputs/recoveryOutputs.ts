import type { IdlAccounts } from "@coral-xyz/anchor"

import { outputKey } from "@wireio/cluster-tool"
import type { LiqsolCore } from "@wireio/outpost-solana-artifacts"
import type { SysioContracts } from "@wireio/sdk-core"

/** Immutable accepted row captured while its original source digest still exists. */
export const OriginalEnvelope = outputKey<SysioContracts.SysioSyndEnvelopeRowType>(
  "pluginUnderwritingRecovery.originalEnvelope", "accepted syndication before pruning"
)
/** Matching newer checkpoint captured before restarting the absent underwriter. */
export const PrunedCheckpoint = outputKey<SysioContracts.SysioMsgchOutpostConsensusEntryType>(
  "pluginUnderwritingRecovery.prunedCheckpoint", "source-authenticated checkpoint after pruning"
)
/** Exact finalized account observed when pruning and checkpoint authentication both succeeded. */
export const PrunedSourceLog = outputKey<IdlAccounts<LiqsolCore>["envelopeLog"]>(
  "pluginUnderwritingRecovery.prunedSourceLog", "finalized source audit account after pruning"
)
