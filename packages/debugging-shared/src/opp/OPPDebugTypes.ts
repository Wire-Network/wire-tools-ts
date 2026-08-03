import type {
  DebugEnvelopeMetadataRecord,
  DebugOutpostEndpointsType,
  Envelope
} from "@wireio/opp-typescript-models"

/**
 * Serializable view of a decoded envelope pair — plain objects, no BigInt
 * or Uint8Array. BigInts have been stringified and bytes base64-encoded
 * by the producer (server or local-disk client) before being handed off
 * to the consumer (UI / Redux).
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
   * Unix-ms timestamp the producer decoded this envelope. Drives
   * "when was this last seen" displays in consumer UIs.
   */
  receivedAt: number
}

/**
 * One decoded envelope record paired with the epoch its storage key was filed
 * under — what every `.data`/`.metadata` reader produces per pair, BEFORE the
 * per-epoch grouping. Contrast {@link DebugOPPEpochRecord}, which carries ALL
 * envelopes observed for one epoch.
 */
export interface DebugOPPEpochEnvelopeRecord {
  /** Epoch index parsed from the storage key's zero-padded prefix. */
  epoch: number
  /** The decoded, plainified envelope record. */
  record: DebugOPPEnvelopeRecord
}

/** Per-epoch cache entry. Multiple envelopes per epoch under fraud scenarios. */
export interface DebugOPPEpochRecord {
  epoch: number
  envelopes: DebugOPPEnvelopeRecord[]
}

/** Identity-mapped event kind for the `EnvelopeWatch` stream subscription. */
export enum EnvelopeEventKind {
  /** Replayed event for a record that already existed when the subscription opened. */
  Hydrated = "hydrated",
  /** Newly-observed record after the subscription opened. */
  Added = "added"
}

/**
 * Stream event for the `EnvelopeWatch` subscription — the
 * {@link DebugOPPEpochEnvelopeRecord} the reader produced, tagged with how the
 * subscriber came by it. Hydration arrives in its own kind so the consumer can
 * choose to bulk-dispatch the initial set vs. append individual records once
 * the stream is live. The `(epoch, record)` pair is INHERITED, never
 * re-declared, so the two shapes cannot drift.
 */
export interface EnvelopeEvent extends DebugOPPEpochEnvelopeRecord {
  /** Whether the record predates the subscription or was observed live. */
  kind: EnvelopeEventKind
}

/** Empty params object for the `EnvelopeWatch` stream subscription. */
export interface EnvelopeWatchStreamParams {}

/**
 * Request body for `OPP.LoadRecords` — bulk-read of fully-decoded envelope
 * records grouped by epoch. Drives "load older" affordances in client UIs;
 * unlike `EnvelopeList` (lightweight metadata only) this returns the
 * plainified envelope + metadata payloads in a single round trip.
 */
export interface LoadEnvelopeRecordsRequest {
  /** Inclusive lower-bound epoch index. Omit for no lower bound. */
  epochStart?: number
  /** Inclusive upper-bound epoch index. Omit for no upper bound. */
  epochEnd?: number
  /** Restrict to one endpoints variant. Omit (or pass `UNKNOWN`) for every variant. */
  endpointsType?: DebugOutpostEndpointsType
}

/** Response body for `OPP.LoadRecords`. */
export interface LoadEnvelopeRecordsResponse {
  /** Decoded epoch records, sorted ascending by `epoch`. */
  records: DebugOPPEpochRecord[]
}
