import { Envelope } from "@wireio/opp-typescript-models"

/** Protobuf wire type for length-delimited fields. */
const LengthDelimitedWireType = 2,
  /** Protobuf wire type for varint fields. */
  VarintWireType = 0,
  /** Byte written into synthetic padding payloads. */
  PaddingByte = 1

/**
 * Encode one protobuf varint.
 * @param value Non-negative integer to encode.
 * @return The varint bytes.
 */
export function encodeProtobufVarint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value
  do {
    const byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    bytes.push(remaining === 0 ? byte : byte | 0x80)
  } while (remaining !== 0)
  return Buffer.from(bytes)
}

/**
 * Build one length-delimited field carrying a synthetic payload.
 * @param fieldNumber Field number to encode.
 * @param payloadByteLength Payload size used as saturation padding.
 * @return The encoded tag, length, and payload.
 */
export function lengthDelimitedField(
  fieldNumber: number,
  payloadByteLength: number
): Buffer {
  return Buffer.concat([
    encodeProtobufVarint((fieldNumber << 3) | LengthDelimitedWireType),
    encodeProtobufVarint(payloadByteLength),
    Buffer.alloc(payloadByteLength, PaddingByte)
  ])
}

/**
 * Build one varint field.
 * @param fieldNumber Field number to encode.
 * @param value Varint value to encode.
 * @return The encoded tag and value.
 */
export function varintField(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([
    encodeProtobufVarint((fieldNumber << 3) | VarintWireType),
    encodeProtobufVarint(value)
  ])
}

/**
 * Concatenate encoded field byte runs into one message body.
 * @param parts Encoded field runs in wire order.
 * @return The concatenated bytes.
 */
export function concatFieldBytes(parts: readonly Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts.map(part => Buffer.from(part))))
}

/**
 * Serialize the canonical envelope fixture the exploit tests decode to.
 * @param epochIndex Epoch index carried by the envelope.
 * @return Canonical generated-serializer bytes.
 */
export function canonicalEnvelopeBytes(epochIndex: number): Uint8Array {
  return Envelope.toBinary(
    Envelope.create({
      epochIndex,
      epochTimestamp: 1n,
      envelopeHash: new Uint8Array(32),
      previousEnvelopeHash: new Uint8Array(32)
    })
  )
}
