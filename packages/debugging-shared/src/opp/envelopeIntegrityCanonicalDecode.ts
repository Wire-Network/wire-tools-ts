import {
  BinaryReader,
  RepeatType,
  WireType,
  type IMessageType
} from "@protobuf-ts/runtime"

/**
 * Decode untrusted bytes that must be a canonical encoding of `messageType`.
 *
 * `readUnknownField: "throw"` alone rejects only unrecognised field numbers. A
 * KNOWN singular field repeated on the wire still decodes cleanly because the
 * last occurrence wins, so a forged message can carry unlimited padding, decode
 * to exactly the expected values, and inflate byte-threshold saturation
 * accounting. Every strict evidence path decodes through here so that class is
 * rejected before any bytes earn saturation credit.
 *
 * @param messageType Generated message type whose descriptor defines cardinality.
 * @param bytes Untrusted source bytes.
 * @return The decoded message.
 * @throws Error when the encoding repeats a singular field, uses a group, or
 *   names a field the descriptor does not declare.
 */
export function decodeCanonicalMessage<T extends object>(
  messageType: IMessageType<T>,
  bytes: Uint8Array
): T {
  assertCanonicalFieldCardinality(messageType, bytes)
  return messageType.fromBinary(bytes, { readUnknownField: "throw" })
}

/**
 * Reject any wire encoding whose field cardinality is not canonical.
 *
 * A protobuf tag stream is length-prefixed and self-describing only when read
 * sequentially, so the scan advances a cursor rather than iterating a
 * collection — the fields are not known until the bytes have been walked.
 */
function assertCanonicalFieldCardinality<T extends object>(
  messageType: IMessageType<T>,
  bytes: Uint8Array
): void {
  const reader = new BinaryReader(bytes),
    seen = new Set<number>()
  while (reader.pos < reader.len) {
    const [fieldNo, wireType] = reader.tag()
    if (wireType === WireType.StartGroup || wireType === WireType.EndGroup)
      throw new Error(
        `${messageType.typeName} field ${fieldNo} uses unsupported group encoding`
      )
    reader.skip(wireType)
    if (seen.has(fieldNo) && !mayRepeat(messageType, fieldNo))
      throw new Error(
        `${messageType.typeName} repeats singular field ${fieldNo}`
      )
    seen.add(fieldNo)
  }
}

/** Whether the descriptor permits `fieldNo` to occur more than once on the wire. */
function mayRepeat<T extends object>(
  messageType: IMessageType<T>,
  fieldNo: number
): boolean {
  const field = messageType.fields.find(entry => entry.no === fieldNo)
  if (!field) return false
  return field.kind === "map" || field.repeat !== RepeatType.NO
}
