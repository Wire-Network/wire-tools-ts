import { ethers } from "ethers"
import { AttestationType, Envelope } from "@wireio/opp-typescript-models"

/**
 * Canonical OPP envelope codec for the slashing flow's synthetic dispute envelopes.
 *
 * Since SEC-102 (Wire-Network/wire-sysio#508), `sysio.msgch::apply_consensus` validates the
 * `opp.proto` MessageHeader semantics AND the per-outpost chains before dispatching, so the winning
 * dispute envelope (and the non-contested consensus envelope) need a spec-correct, chained header.
 * The header checksums are keccak256 over the FIELD-COMPLETE canonical encoding (every singular
 * field written, defaults included) — which protobuf-ts `toBinary` does NOT produce — so they are
 * computed here with the small canonical encoder below. It mirrors the depot's
 * `contracts/sysio.opp.common/include/sysio.opp.common/opp_canonical_codec.hpp` and the C++ oracle
 * in `contracts/tests/opp_envelope_oracle.hpp`; the golden vectors it must reproduce are pinned in
 * `contracts/tests/sysio.msgch_chain_tests.cpp` (and, cross-language, in the wire-solana / wire-
 * ethereum vector suites).
 *
 * The DELIVERED wire bytes stay `Envelope.toBinary` output (see {@link encodeTaggedEnvelope}): the
 * depot decodes them and re-canonicalises before recomputing, so a non-canonical-but-decodable wire
 * form validates identically. Only the checksums we embed must match the canonical preimage.
 */

/** Empty canonical byte string — genesis message id / envelope hash, and the blanked digest fields. */
const CanonicalEmpty = new Uint8Array(0)

/** Protobuf wire type for a length-delimited (bytes / sub-message) field. */
const WireTypeLengthDelimited = 2
/** Protobuf wire type for a varint field. */
const WireTypeVarint = 0

// ── Field numbers (opp.proto) ────────────────────────────────────────────────
// Grouped by message so a proto field renumber is a one-line change here.

/** `opp.MessageHeader` field numbers (slot 4, the removed `encoding_flags`, is never encoded). */
const HeaderField = {
  endpoints: 1,
  messageId: 2,
  previousMessageId: 3,
  payloadSize: 5,
  payloadChecksum: 6,
  timestamp: 7,
  headerChecksum: 8
} as const

/** `opp.MessagePayload` field numbers. */
const PayloadField = { version: 1, attestation: 2 } as const

/** `opp.Attestation` field numbers. */
const AttestationField = { type: 1, dataSize: 2, data: 3 } as const

/** `opp.ChainId` field numbers (a routing endpoint's kind + id). */
const ChainIdField = { kind: 1, id: 2 } as const

/** `opp.Endpoints` field numbers (start + end routing endpoints). */
const EndpointsField = { start: 1, end: 2 } as const

// ── Primitive canonical encoders ─────────────────────────────────────────────

/** Base-128 varint encoding of a non-negative value. */
function canonicalVarint(value: bigint): number[] {
  const out: number[] = []
  while (value >= 0x80n) {
    out.push(Number(value & 0x7fn) | 0x80)
    value >>= 7n
  }
  out.push(Number(value))
  return out
}

/** A protobuf field tag: `(field << 3) | wireType`, varint-encoded. */
const canonicalTag = (field: number, wireType: number) =>
  canonicalVarint(BigInt((field << 3) | wireType))

/** A varint field: tag + varint value. */
const canonicalVarintField = (field: number, value: bigint | number) => [
  ...canonicalTag(field, WireTypeVarint),
  ...canonicalVarint(BigInt(value))
]

/** A length-delimited bytes field: tag + length + bytes. */
const canonicalBytesField = (field: number, bytes: Uint8Array) => [
  ...canonicalTag(field, WireTypeLengthDelimited),
  ...canonicalVarint(BigInt(bytes.length)),
  ...bytes
]

/** A length-delimited sub-message field: tag + length + already-encoded body. */
const canonicalSubMessage = (field: number, body: number[]) => [
  ...canonicalTag(field, WireTypeLengthDelimited),
  ...canonicalVarint(BigInt(body.length)),
  ...body
]

/** An `opp.ChainId` body (kind + id). */
const canonicalChainId = (kind: number, id: number) => [
  ...canonicalVarintField(ChainIdField.kind, kind),
  ...canonicalVarintField(ChainIdField.id, id)
]

/**
 * The default `opp.Endpoints` body: both endpoints are reserved-default across all emitters
 * (routing derives from the proven chain), so each carries a zero-kind, zero-id chain id.
 */
const canonicalEndpointsDefault = () => [
  ...canonicalSubMessage(EndpointsField.start, canonicalChainId(0, 0)),
  ...canonicalSubMessage(EndpointsField.end, canonicalChainId(0, 0))
]

/** An `opp.Attestation` body (type + data_size + data). */
const canonicalAttestation = (att: {
  type: number
  dataSize: number
  data: Uint8Array
}) => [
  ...canonicalVarintField(AttestationField.type, att.type),
  ...canonicalVarintField(AttestationField.dataSize, att.dataSize),
  ...canonicalBytesField(AttestationField.data, att.data)
]

/** An `opp.MessagePayload` body (version + repeated attestation sub-messages). */
const canonicalPayload = (
  version: number,
  atts: { type: number; dataSize: number; data: Uint8Array }[]
) => [
  ...canonicalVarintField(PayloadField.version, version),
  ...atts.flatMap(att =>
    canonicalSubMessage(PayloadField.attestation, canonicalAttestation(att))
  )
]

/** An `opp.MessageHeader` body in field-complete canonical form (slot 4 reserved, never encoded). */
const canonicalHeader = (header: {
  messageId: Uint8Array
  previousMessageId: Uint8Array
  payloadSize: number
  payloadChecksum: Uint8Array
  timestamp: bigint
  headerChecksum: Uint8Array
}) => [
  ...canonicalSubMessage(HeaderField.endpoints, canonicalEndpointsDefault()),
  ...canonicalBytesField(HeaderField.messageId, header.messageId),
  ...canonicalBytesField(
    HeaderField.previousMessageId,
    header.previousMessageId
  ),
  ...canonicalVarintField(HeaderField.payloadSize, header.payloadSize),
  ...canonicalBytesField(HeaderField.payloadChecksum, header.payloadChecksum),
  ...canonicalVarintField(HeaderField.timestamp, header.timestamp),
  ...canonicalBytesField(HeaderField.headerChecksum, header.headerChecksum)
]

/** keccak256 of the given bytes, as a 32-byte array. */
const keccakBytes = (bytes: number[] | Uint8Array) =>
  ethers.getBytes(ethers.keccak256(Uint8Array.from(bytes)))

/** Big-endian sequence number in the first 8 bytes of a message id; 0 when empty (genesis). */
function messageSequence(messageId: Uint8Array): bigint {
  return messageId.length < 8 ? 0n : ethers.toBigInt(messageId.slice(0, 8))
}

/** `headerChecksum` with its first 8 bytes replaced by the big-endian sequence number. */
function deriveMessageId(
  headerChecksum: Uint8Array,
  sequence: bigint
): Uint8Array {
  const out = new Uint8Array(headerChecksum)
  out.set(ethers.getBytes(ethers.toBeHex(sequence, 8)), 0)
  return out
}

// ── Semantic header derivation (opp.proto MessageHeader, SEC-102) ─────────────

/** One attestation for {@link deriveSemanticHeader}; `data_size` is derived from `data.length`. */
export interface CanonicalAttestation {
  /** `Attestation.type` (an `AttestationType` value). */
  type: number
  /** `Attestation.data` — the raw attestation bytes. */
  data: Uint8Array
}

/** Inputs to {@link deriveSemanticHeader} — the varying content of one OPP message. */
export interface SemanticHeaderInput {
  /** `MessagePayload.version`. */
  version: number
  /** The message's attestations (encoded field-complete, in order). */
  attestations: CanonicalAttestation[]
  /** `MessageHeader.timestamp` — milliseconds since the Unix epoch. */
  timestampMs: bigint
  /** The outpost's current inbound message tip (empty at stream genesis). */
  previousMessageId: Uint8Array
}

/** The derived, spec-correct `opp.MessageHeader` checksum fields. */
export interface SemanticHeader {
  /** `payload_size`: the length of the canonical payload encoding. */
  payloadSize: number
  /** `payload_checksum`: keccak256 over the canonical payload bytes. */
  payloadChecksum: Uint8Array
  /** `header_checksum`: keccak256 over the blanked canonical header. */
  headerChecksum: Uint8Array
  /** `message_id`: `header_checksum` with its first 8 bytes spliced to the sequence number. */
  messageId: Uint8Array
}

/**
 * Derive the SEC-102 semantic header fields for one OPP message per the spec: `payload_size` /
 * `payload_checksum` over the canonical payload bytes, `header_checksum` over the canonical header
 * with `message_id` and `header_checksum` blanked, and `message_id` = that checksum with the
 * big-endian sequence number (`seq(previousMessageId) + 1`) spliced over its first 8 bytes.
 *
 * This is the cross-language canonical primitive: for the pinned inputs it reproduces the C++ oracle
 * (and Solidity/Rust) golden vectors byte-for-byte.
 *
 * @param input - The message's varying content + its predecessor's message id.
 * @returns The derived header checksum fields.
 */
export function deriveSemanticHeader(
  input: SemanticHeaderInput
): SemanticHeader {
  const atts = input.attestations.map(att => ({
    type: att.type,
    dataSize: att.data.length,
    data: att.data
  }))
  const payloadCanonical = canonicalPayload(input.version, atts)
  const payloadChecksum = keccakBytes(payloadCanonical)
  const headerChecksum = keccakBytes(
    canonicalHeader({
      messageId: CanonicalEmpty,
      previousMessageId: input.previousMessageId,
      payloadSize: payloadCanonical.length,
      payloadChecksum,
      timestamp: input.timestampMs,
      headerChecksum: CanonicalEmpty
    })
  )
  const messageId = deriveMessageId(
    headerChecksum,
    messageSequence(input.previousMessageId) + 1n
  )
  return {
    payloadSize: payloadCanonical.length,
    payloadChecksum,
    headerChecksum,
    messageId
  }
}

// ── Tagged dispute envelope ───────────────────────────────────────────────────

/** Inputs to {@link encodeTaggedEnvelope}. */
export interface TaggedEnvelopeInput {
  /** The contested epoch the envelope claims. */
  epochIndex: number
  /** `Envelope.epoch_envelope_index` fixture. */
  epochEnvelopeIndex: number
  /** `Envelope.epoch_timestamp` / `MessageHeader.timestamp` — milliseconds since the Unix epoch. */
  epochTimestampMs: bigint
  /** `MessagePayload.version` fixture. */
  payloadVersion: number
  /** The benign payload tag distinguishing this envelope's checksum. */
  tag: string
  /**
   * The outpost's current inbound MESSAGE tip (empty at stream genesis) — the header must continue
   * it (`previous_message_id`), and the derived `message_id` carries `seq(tip) + 1`.
   */
  previousMessageId: Uint8Array
  /**
   * The outpost's current inbound ENVELOPE tip (`outpcons.envelope_digest`, empty at stream
   * genesis) — `apply_consensus` drops any non-genesis envelope whose `previous_envelope_hash`
   * does not equal it, BEFORE the semantic-header check, so it must be chained here too.
   */
  previousEnvelopeHash: Uint8Array
}

/**
 * Encode a valid OPP Envelope for `epochIndex` whose only varying content is `tag`, so the depot's
 * `sha256(data)` differs per tag (that is what produces the distinct dispute-candidate checksums).
 *
 * Mirrors `contracts/tests/sysio.dispute_tests.cpp::encode_envelope`: one message carrying one
 * benign `ATTESTATION_TYPE_UNSPECIFIED` attestation whose `data` is the tag (UNSPECIFIED makes the
 * winner's eventual dispatch a no-op). The semantic header is derived per {@link deriveSemanticHeader}
 * and BOTH chains are continued — the message chain via `previous_message_id` and the envelope chain
 * via `previous_envelope_hash` — so the winning envelope passes `apply_consensus`.
 *
 * The returned bytes are `Envelope.toBinary` output (the depot re-canonicalises on receipt); only
 * the embedded checksums are canonical.
 *
 * @param input - The epoch, fixtures, tag, and both inbound chain tips.
 * @returns The serialized envelope bytes.
 */
export function encodeTaggedEnvelope(input: TaggedEnvelopeInput): Uint8Array {
  const data = new TextEncoder().encode(input.tag)
  const attestations: CanonicalAttestation[] = [
    { type: AttestationType.UNSPECIFIED, data }
  ]
  const header = deriveSemanticHeader({
    version: input.payloadVersion,
    attestations,
    timestampMs: input.epochTimestampMs,
    previousMessageId: input.previousMessageId
  })
  return Envelope.toBinary(
    Envelope.create({
      epochIndex: input.epochIndex,
      epochEnvelopeIndex: input.epochEnvelopeIndex,
      epochTimestamp: input.epochTimestampMs,
      previousEnvelopeHash: input.previousEnvelopeHash,
      messages: [
        {
          header: {
            messageId: header.messageId,
            previousMessageId: input.previousMessageId,
            payloadSize: header.payloadSize,
            payloadChecksum: header.payloadChecksum,
            timestamp: input.epochTimestampMs,
            headerChecksum: header.headerChecksum
          },
          payload: {
            version: input.payloadVersion,
            attestations: [
              { type: AttestationType.UNSPECIFIED, dataSize: data.length, data }
            ]
          }
        }
      ]
    })
  )
}

// ── Chain-state helpers ───────────────────────────────────────────────────────

/**
 * Decode a `checksum256` table field (`outpcons.message_tip` / `outpcons.envelope_digest`) to
 * canonical bytes. An absent, empty, or all-zero field is stream genesis and decodes to EMPTY — the
 * canonical form `apply_consensus` accepts for a genesis `previous_*` (a non-empty value must be the
 * exact 32-byte tip). Tolerates an optional `0x` prefix.
 *
 * @param raw - The raw table field, if present.
 * @returns The 32-byte tip, or empty at genesis.
 */
export function parseChainTip(raw: string | undefined): Uint8Array {
  if (!raw) {
    return CanonicalEmpty
  }
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw
  if (hex.length === 0 || /^0+$/.test(hex)) {
    return CanonicalEmpty
  }
  return ethers.getBytes(`0x${hex}`)
}

/**
 * Hex-encode envelope bytes for the `sysio.msgch::deliver` `data` field.
 *
 * @param bytes - The serialized envelope.
 * @returns The lowercase hex spelling.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}
