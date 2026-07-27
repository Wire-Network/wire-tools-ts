import type { SolanaGenesisHash } from "@wireio/cluster-tool-shared"
import { outputKey, type OutputKey } from "../OutputStore.js"

/** Trusted and successfully verified Solana cluster genesis hash. */
export type SolanaClusterIdentity = SolanaGenesisHash

/** Typed cross-step handle to the verified Solana cluster identity. */
export const SolanaClusterIdentityKey: OutputKey<SolanaClusterIdentity> =
  outputKey(
    "cluster.solanaClusterIdentity",
    "trusted and verified Solana cluster genesis hash"
  )
