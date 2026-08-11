import { Envelope } from "@wireio/opp-typescript-models"

/** Unknown protobuf field number used by the saturation regression fixture. */
export const UnknownProtobufFieldNumber = 500

/** Payload bytes appended to the canonical envelope by the exploit fixture. */
export const UnknownProtobufPayloadByteLength = 62_300

/** Exact forged envelope size produced by the canonical regression fixture. */
export const UnknownProtobufExploitByteLength = 62_378

/** Append one unknown length-delimited field to already encoded protobuf bytes. */
export function appendUnknownLengthDelimitedField(
  bytes: Uint8Array,
  payloadByteLength = UnknownProtobufPayloadByteLength
): Buffer {
  const tag = encodeVarint((UnknownProtobufFieldNumber << 3) | 2),
    length = encodeVarint(payloadByteLength)
  return Buffer.concat([
    Buffer.from(bytes),
    tag,
    length,
    Buffer.alloc(payloadByteLength, 1)
  ])
}

/** Build the exact checksum-recomputable unknown-field saturation exploit. */
export function unknownFieldSaturationExploitBytes(
  epochIndex: number
): Buffer {
  const canonical = Envelope.toBinary(
    Envelope.create({
      epochIndex,
      epochTimestamp: 1n,
      envelopeHash: new Uint8Array(32),
      previousEnvelopeHash: new Uint8Array(32)
    })
  )
  return appendUnknownLengthDelimitedField(canonical)
}

/**
 * Encode one protobuf varint.
 * @param value Non-negative integer to encode.
 * @return The varint bytes.
 */
export function encodeVarint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value
  do {
    const byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    bytes.push(remaining === 0 ? byte : byte | 0x80)
  } while (remaining !== 0)
  return Buffer.from(bytes)
}
