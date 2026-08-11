import { Envelope } from "@wireio/opp-typescript-models"

import { encodeVarint } from "./unknownProtobufFieldTestSupport.js"

/** Singular `envelope_hash` field duplicated by the saturation padding fixture. */
export const DuplicateEnvelopeHashFieldNumber = 1

/** Singular `checksum` field duplicated by the metadata fixture. */
export const DuplicateMetadataChecksumFieldNumber = 1

/** Payload bytes carried by the duplicated known field. */
export const DuplicateProtobufPayloadByteLength = 62_300

/** Exact forged envelope size produced by the duplicate-field fixture. */
export const DuplicateProtobufExploitByteLength = 62_377

/**
 * Prepend a duplicate length-delimited occurrence of a KNOWN singular field.
 *
 * Protobuf resolves a repeated singular field to its last occurrence, so the
 * trailing canonical bytes still decode to the expected values while the
 * leading duplicate inflates the encoded size.
 *
 * @param bytes Canonical encoded message bytes.
 * @param fieldNumber Known singular field number to duplicate.
 * @param payloadByteLength Padding payload size.
 * @return The forged bytes.
 */
export function prependDuplicateKnownField(
  bytes: Uint8Array,
  fieldNumber: number,
  payloadByteLength = DuplicateProtobufPayloadByteLength
): Buffer {
  return Buffer.concat([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(payloadByteLength),
    Buffer.alloc(payloadByteLength, 1),
    Buffer.from(bytes)
  ])
}

/** Build the checksum-recomputable duplicate-known-field saturation exploit. */
export function duplicateFieldSaturationExploitBytes(
  epochIndex: number
): Buffer {
  return prependDuplicateKnownField(
    Envelope.toBinary(
      Envelope.create({
        epochIndex,
        epochTimestamp: 1n,
        envelopeHash: new Uint8Array(32),
        previousEnvelopeHash: new Uint8Array(32)
      })
    ),
    DuplicateEnvelopeHashFieldNumber
  )
}
