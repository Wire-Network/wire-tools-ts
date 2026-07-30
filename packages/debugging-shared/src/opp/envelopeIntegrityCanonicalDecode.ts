import {
  BinaryReader,
  RepeatType,
  ScalarType,
  WireType,
  type FieldInfo,
  type IMessageType
} from "@protobuf-ts/runtime"
import { match } from "ts-pattern"

/** Protobuf map entries always encode the key as field number 1. */
const MapEntryKeyFieldNumber = 1,
  /** Protobuf map entries always encode the value as field number 2. */
  MapEntryValueFieldNumber = 2

/** Discriminant selecting the map variant out of the `FieldInfo` union. */
interface MapFieldDiscriminant {
  kind: "map"
}

/** Descriptor shape for a `kind: "map"` field. */
type MapFieldInfo = Extract<FieldInfo, MapFieldDiscriminant>

/**
 * Wire type each protobuf scalar type encodes as when written as a single value.
 *
 * Consulted to reject a known field whose on-wire type is incompatible with its
 * descriptor (e.g. a varint scalar arriving length-delimited) before the bytes
 * reach the generated decoder. `satisfies Record<ScalarType, WireType>` forces
 * this table to stay exhaustive if `@protobuf-ts/runtime` adds a scalar type.
 */
const ScalarWireTypes = {
  [ScalarType.INT32]: WireType.Varint,
  [ScalarType.INT64]: WireType.Varint,
  [ScalarType.UINT32]: WireType.Varint,
  [ScalarType.UINT64]: WireType.Varint,
  [ScalarType.SINT32]: WireType.Varint,
  [ScalarType.SINT64]: WireType.Varint,
  [ScalarType.BOOL]: WireType.Varint,
  [ScalarType.FIXED64]: WireType.Bit64,
  [ScalarType.SFIXED64]: WireType.Bit64,
  [ScalarType.DOUBLE]: WireType.Bit64,
  [ScalarType.STRING]: WireType.LengthDelimited,
  [ScalarType.BYTES]: WireType.LengthDelimited,
  [ScalarType.FIXED32]: WireType.Bit32,
  [ScalarType.SFIXED32]: WireType.Bit32,
  [ScalarType.FLOAT]: WireType.Bit32
} satisfies Readonly<Record<ScalarType, WireType>>

/**
 * Raised when untrusted bytes are not a canonical encoding of their descriptor.
 *
 * A named subclass lets callers distinguish a structural-integrity rejection
 * from an arbitrary decode failure while still satisfying the `instanceof Error`
 * checks every strict evidence path maps to `DataDecodeFailed` /
 * `MetadataDecodeFailed`.
 */
export class NonCanonicalEnvelopeProtobufError extends Error {
  readonly name = "NonCanonicalEnvelopeProtobufError"
}

/**
 * Decode untrusted bytes that must be a canonical encoding of `messageType`.
 *
 * `readUnknownField: "throw"` alone rejects only unrecognised field numbers. A
 * KNOWN singular field repeated on the wire still decodes cleanly because the
 * last occurrence wins, so a forged message can carry unlimited padding, decode
 * to exactly the expected values, and inflate byte-threshold saturation
 * accounting. `scanMessage` closes that gap descriptor-first: it rejects
 * duplicate singular fields, groups, and — for every known field — an on-wire
 * type the descriptor does not permit, recursing into nested messages and map
 * entries so the guarantee holds at every depth. Every strict evidence path
 * decodes through here so those classes are rejected before any bytes earn
 * saturation credit.
 *
 * @param messageType Generated message type whose descriptor defines cardinality.
 * @param bytes Untrusted source bytes.
 * @return The decoded message.
 * @throws NonCanonicalEnvelopeProtobufError when the encoding repeats a singular
 *   field, uses a group, or gives a known field an incompatible wire type — at
 *   the top level or inside any nested message or map entry.
 * @throws Error when the encoding names a field the descriptor does not declare
 *   (surfaced by the generated `readUnknownField: "throw"` backstop).
 */
export function decodeCanonicalMessage<T extends object>(
  messageType: IMessageType<T>,
  bytes: Uint8Array
): T {
  scanMessage(bytes, messageType)
  return messageType.fromBinary(bytes, { readUnknownField: "throw" })
}

/**
 * Whether `wireType` is a legal on-wire representation of a scalar descriptor.
 *
 * A repeated scalar may additionally arrive length-delimited (packed), so
 * `repeat` widens the accepted set beyond the single canonical wire type.
 */
function isScalarWireTypeCompatible(
  type: ScalarType,
  repeat: RepeatType,
  wireType: WireType
): boolean {
  return (
    wireType === ScalarWireTypes[type] ||
    (repeat !== RepeatType.NO && wireType === WireType.LengthDelimited)
  )
}

/**
 * Whether `wireType` is a legal on-wire representation of a message field.
 *
 * Dispatches on the descriptor's `kind`: scalars defer to their wire family,
 * enums accept varint (plus packed length-delimited when repeated), and message
 * and map fields are always length-delimited.
 */
function isFieldWireTypeCompatible(
  field: FieldInfo,
  wireType: WireType
): boolean {
  return match(field)
    .with({ kind: "scalar" }, value =>
      isScalarWireTypeCompatible(value.T, value.repeat, wireType)
    )
    .with(
      { kind: "enum" },
      value =>
        wireType === WireType.Varint ||
        (value.repeat !== RepeatType.NO &&
          wireType === WireType.LengthDelimited)
    )
    .with(
      { kind: "message" },
      { kind: "map" },
      () => wireType === WireType.LengthDelimited
    )
    .exhaustive()
}

/**
 * Whether `wireType` is legal for one field inside a map entry.
 *
 * Field 1 is the key (always singular) and field 2 the value; any other field
 * number is not part of a map entry and is accepted so the generated decoder can
 * make the final ruling.
 */
function isMapEntryWireTypeCompatible(
  field: MapFieldInfo,
  fieldNumber: number,
  wireType: WireType
): boolean {
  if (fieldNumber === MapEntryKeyFieldNumber)
    return isScalarWireTypeCompatible(field.K, RepeatType.NO, wireType)
  if (fieldNumber !== MapEntryValueFieldNumber) return true
  return match(field.V)
    .with({ kind: "scalar" }, value =>
      isScalarWireTypeCompatible(value.T, RepeatType.NO, wireType)
    )
    .with({ kind: "enum" }, () => wireType === WireType.Varint)
    .with({ kind: "message" }, () => wireType === WireType.LengthDelimited)
    .exhaustive()
}

/**
 * Scan one protobuf map entry for singular cardinality and nested message fields.
 *
 * @param bytes Encoded map-entry payload.
 * @param field Descriptor for the enclosing map field.
 */
function scanMapEntry(bytes: Uint8Array, field: MapFieldInfo): void {
  const reader = new BinaryReader(bytes),
    seen = new Set<number>()

  // Cursor-walk, not iteration over a collection: a protobuf tag stream is only
  // self-describing when read sequentially. `while` keeps the scan iterative so
  // an adversarial field count can't exhaust the call stack.
  while (reader.pos < reader.len) {
    const [fieldNumber, wireType] = reader.tag()
    if (wireType === WireType.StartGroup || wireType === WireType.EndGroup)
      throw new NonCanonicalEnvelopeProtobufError(
        `${field.name} map entry field ${fieldNumber} uses unsupported group encoding`
      )

    const isEntryField =
      fieldNumber === MapEntryKeyFieldNumber ||
      fieldNumber === MapEntryValueFieldNumber
    if (
      isEntryField &&
      !isMapEntryWireTypeCompatible(field, fieldNumber, wireType)
    )
      throw new NonCanonicalEnvelopeProtobufError(
        `${field.name} map entry field ${fieldNumber} has incompatible wire type ${wireType}`
      )
    if (isEntryField && seen.has(fieldNumber))
      throw new NonCanonicalEnvelopeProtobufError(
        `${field.name} map entry repeats singular field ${fieldNumber}`
      )
    if (isEntryField) seen.add(fieldNumber)

    if (
      fieldNumber === MapEntryValueFieldNumber &&
      wireType === WireType.LengthDelimited &&
      field.V.kind === "message"
    )
      scanMessage(reader.bytes(), field.V.T())
    else reader.skip(wireType)
  }
}

/**
 * Scan a protobuf message using runtime descriptors to enforce canonical shape.
 *
 * Rejects groups, and for every known field rejects an incompatible wire type
 * and a repeated singular occurrence, recursing into nested message and map
 * bytes so the guarantee holds at every depth. Unknown field numbers are left
 * for the generated `readUnknownField: "throw"` backstop.
 *
 * @param bytes Encoded message bytes.
 * @param messageType Runtime descriptor for the encoded message.
 */
function scanMessage(
  bytes: Uint8Array,
  messageType: IMessageType<object>
): void {
  const reader = new BinaryReader(bytes),
    fieldsByNumber = new Map(messageType.fields.map(field => [field.no, field])),
    seen = new Set<number>()

  // Cursor-walk, not iteration over a collection: a protobuf tag stream is only
  // self-describing when read sequentially. `while` keeps the scan iterative so
  // an adversarial field count can't exhaust the call stack.
  while (reader.pos < reader.len) {
    const [fieldNumber, wireType] = reader.tag(),
      field = fieldsByNumber.get(fieldNumber)
    if (wireType === WireType.StartGroup || wireType === WireType.EndGroup)
      throw new NonCanonicalEnvelopeProtobufError(
        `${messageType.typeName} field ${fieldNumber} uses unsupported group encoding`
      )

    if (field !== undefined) {
      if (!isFieldWireTypeCompatible(field, wireType))
        throw new NonCanonicalEnvelopeProtobufError(
          `${messageType.typeName} field ${fieldNumber} has incompatible wire type ${wireType}`
        )
      const isSingular = field.kind !== "map" && field.repeat === RepeatType.NO
      if (isSingular && seen.has(fieldNumber))
        throw new NonCanonicalEnvelopeProtobufError(
          `${messageType.typeName} repeats singular field ${fieldNumber}`
        )
      seen.add(fieldNumber)
    }

    if (field?.kind === "message" && wireType === WireType.LengthDelimited)
      scanMessage(reader.bytes(), field.T())
    else if (field?.kind === "map" && wireType === WireType.LengthDelimited)
      scanMapEntry(reader.bytes(), field)
    else reader.skip(wireType)
  }
}
