import type {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"

/**
 * Serializable view of a decoded envelope pair — plain objects, no BigInt
 * or Uint8Array. BigInts have been stringified and bytes base64-encoded
 * by the service before reaching Redux.
 */
export interface DebugOPPEnvelopeRecord {
  /** 16-hex-char truncated sha256 — matches server filename encoding. */
  checksum: string
  /** Outpost-endpoint enum value parsed from the filename. */
  endpointsType: DebugOutpostEndpointsType
  /** Decoded envelope. Batch-op names live on `metadata.batchOpNames`. */
  envelope: Envelope
  /** Decoded metadata record — includes `batchOpNames`. */
  metadata: DebugEnvelopeMetadataRecord
  /**
   * Unix-ms timestamp the tracking service decoded this envelope. Drives
   * the `updated_timestamp` column in `EpochTrackerPanel` — the most-recent
   * `receivedAt` across an epoch's envelopes is "when this epoch last
   * changed".
   */
  receivedAt: number
}

/** Per-epoch cache entry. Multiple envelopes per epoch under fraud scenarios. */
export interface DebugOPPEpochRecord {
  epoch: number
  envelopes: DebugOPPEnvelopeRecord[]
}

/** OPP slice shape — bounded LRU over epoch index. */
export interface OPPState {
  /** Highest epoch observed across all envelopes. */
  epochIndex: number
  /** Epoch → record. Bounded to {@link OPPState.MaxEpochs} via {@link OPPState}. */
  epochs: Record<number, DebugOPPEpochRecord>
  /** Sorted-ascending list of cached epoch indices. Length ≤ `MaxEpochs`. */
  epochOrder: number[]
}

export namespace OPPState {
  /** LRU cap. Changing this affects how many historical epochs stay in memory. */
  export const MaxEpochs = 1_000
}
