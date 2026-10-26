import { z } from "zod"

/**
 * The block tags `outpost_ethereum_client_plugin` reads what an outpost emitted
 * at (`--outpost-ethereum-read-block-tag`); the values are nodeop's own
 * spellings.
 */
export enum EthereumReadBlockTag {
  finalized = "finalized",
  safe = "safe",
  latest = "latest"
}

/**
 * The read confirmation of every operator daemon's Ethereum client (persisted
 * as `ClusterConfig.ethereumRead`): how settled the outpost state a daemon acts
 * on must be. Every member is nullable — `null` is "not set, nodeop's default
 * governs" (`latest`, 12 confirmations, a 1152 s finality-lag limit) — and
 * every set member renders as one nodeop flag. One cluster-wide setting keeps
 * every operator the harness starts reading alike: an operator reading weaker
 * than its group risks a slash across a deep reorg, and one reading stronger
 * delivers after consensus, a no-op recorded as a miss.
 */
export const EthereumReadConfirmationConfigSchema = z.object({
  /** `--outpost-ethereum-read-block-tag`. */
  blockTag: z.enum(EthereumReadBlockTag).nullable(),
  /**
   * `--outpost-ethereum-read-confirmations`: how deep a `latest` read is, the
   * head counting as one.
   */
  confirmations: z.number().int().positive().nullable(),
  /**
   * `--outpost-ethereum-read-max-finality-lag-sec`: how far the finalized block
   * may trail the head before a `latest` read falls back to it.
   */
  maxFinalityLagSec: z.number().int().positive().nullable()
})
/** The resolved read confirmation — the shape of {@link EthereumReadConfirmationConfigSchema}. */
export type EthereumReadConfirmationConfig = z.infer<
  typeof EthereumReadConfirmationConfigSchema
>

/**
 * A read confirmation with every member unset (`null`): nodeop's defaults
 * govern — the value a caller starts from, and the one a cluster that sets
 * nothing persists.
 *
 * @returns A fresh all-unset config.
 */
export function createUnsetEthereumReadConfirmationConfig(): EthereumReadConfirmationConfig {
  return { blockTag: null, confirmations: null, maxFinalityLagSec: null }
}

/** Caller options: every member optional; `EthereumReadConfirmationConfigProvider.resolve` fills the rest with `null`. */
export type EthereumReadConfirmationOptions =
  Partial<EthereumReadConfirmationConfig>
