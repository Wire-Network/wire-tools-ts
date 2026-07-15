import { parseChainTip } from "./EnvelopeCanonicalCodec.js"
import { SingleFlightCache } from "./SingleFlightCache.js"

/**
 * Single-flight reader of an outpost's inbound chain tips off `sysio.msgch::outpcons`.
 *
 * Lives outside the step module (which imports the cluster-tool harness) with the table query
 * injected, so the full composition — query the rows, select the requested chain, parse both
 * tips, cache the result — is unit-testable; see `../tests/InboundTipReader.test.ts`.
 */

/** The outpost's inbound chain tips from `sysio.msgch::outpcons` (each empty at genesis). */
export interface OutpostInboundTips {
  /**
   * The inbound MESSAGE tip: the raw 32-byte `message_id` the next accepted
   * message must carry in `previous_message_id` (SEC-102 replay guard). Empty
   * at stream genesis: no row yet, or an all-zero tip (the depot leaves
   * `message_tip` zero until the first message-bearing envelope is accepted).
   */
  messageTip: Uint8Array
  /**
   * The inbound ENVELOPE tip: `outpcons.envelope_digest`, the canonical epoch
   * digest the next envelope must carry in `previous_envelope_hash`.
   * `apply_consensus` checks this BEFORE the semantic-header validation and
   * drops any non-genesis envelope that does not continue it, so a headerless
   * (empty) prev-hash is dropped once bootstrap has established a tip. Empty at
   * genesis.
   */
  envelopeDigest: Uint8Array
}

/**
 * The `outpcons` row fields the reader consumes. `message_tip` / `envelope_digest` are new in the
 * deployed ABI (SEC-102) but absent from the pinned SystemContractTypes, so rows arrive as this
 * shape-cast rather than a generated type.
 */
export interface OutpostConsensusRow {
  chain_code: number | string
  message_tip?: string
  envelope_digest?: string
}

/** Supplies the current `outpcons` rows; injected so the reader stays harness-free. */
export type OutpostConsensusQuery = () => Promise<OutpostConsensusRow[]>

/**
 * Caches each outpost's inbound tips per `(chainCode, epochIndex)`, so all deliveries an outpost
 * receives for one contested epoch chain from the SAME pre-delivery tips. The cache is
 * SINGLE-FLIGHT ({@link SingleFlightCache}): the per-operator deliveries run in parallel, so
 * without it each would issue its own read, and once the non-contested outpost's 2/3 majority
 * triggers `apply_consensus` inline and advances the tips, a late read would produce a
 * differently-chained (and so differently-checksummed) envelope — mis-classified as a divergent
 * delivery and wrongly slashed. Registering the in-flight read synchronously collapses the
 * parallel misses onto one read that observes the pre-delivery tips; a rejected read is evicted,
 * so the next call retries instead of caching the failure.
 */
export class InboundTipReader {
  /** In-flight or resolved tip reads by `${chainCode}:${epochIndex}`. */
  private readonly cache = new SingleFlightCache<string, OutpostInboundTips>()

  /**
   * The outpost's inbound tips, read once per `(chainCode, epochIndex)` and shared across that
   * epoch's parallel deliveries.
   *
   * @param chainCode - The outpost slug_name.
   * @param epochIndex - The contested epoch (cache scope, so a later epoch re-reads).
   * @param query - Supplies the current `outpcons` rows on a cache miss.
   * @returns The outpost's inbound tips (each empty at genesis).
   */
  read(
    chainCode: number,
    epochIndex: number,
    query: OutpostConsensusQuery
  ): Promise<OutpostInboundTips> {
    return this.cache.get(`${chainCode}:${epochIndex}`, async () => {
      const rows = await query()
      const row = rows.find(row => String(row.chain_code) === String(chainCode))
      return {
        messageTip: parseChainTip(row?.message_tip),
        envelopeDigest: parseChainTip(row?.envelope_digest)
      }
    })
  }
}
