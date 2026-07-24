import {
  RepeatType,
  ScalarType,
  type EnumInfo,
  type FieldInfo
} from "@protobuf-ts/runtime"
import { Envelope } from "@wireio/opp-typescript-models"

/** Descriptor for a map field's value slot (`kind: "scalar" | "enum" | "message"`). */
type MapValueInfo = Extract<FieldInfo, { kind: "map" }>["V"]

/** Field 6 (`epoch_index`) — a singular varint scalar in the real descriptor. */
export const EpochIndexFieldNumber = 6,
  /** Field 1 (`envelope_hash`) — repurposed as a map field for map tests. */
  EnvelopeHashFieldNumber = 1,
  /** Descriptor for a synthetic enum used to exercise the enum wire branch. */
  TestEnumInfo: EnumInfo = ["test.Enum", { 0: "ZERO", ZERO: 0 }]

/**
 * Build a `FieldInfo` that redeclares field 6 as the given scalar type.
 * @param type Scalar type the swapped descriptor should carry.
 * @param repeat Cardinality; defaults to a singular field.
 * @return The synthetic scalar field descriptor.
 */
export function scalarEnvelopeField(
  type: ScalarType,
  repeat: RepeatType = RepeatType.NO
): FieldInfo {
  // `FieldInfo` discriminates on (repeat, opt, oneof), so a widened `repeat`
  // matches no arm — branch to narrow it to a single union member.
  if (repeat === RepeatType.NO)
    return {
      no: EpochIndexFieldNumber,
      name: "epoch_index",
      localName: "epochIndex",
      jsonName: "epochIndex",
      kind: "scalar",
      T: type,
      repeat: RepeatType.NO,
      opt: false,
      oneof: undefined
    }
  return {
    no: EpochIndexFieldNumber,
    name: "epoch_index",
    localName: "epochIndex",
    jsonName: "epochIndex",
    kind: "scalar",
    T: type,
    repeat,
    opt: false,
    oneof: undefined
  }
}

/**
 * Build a `FieldInfo` that redeclares field 6 as a repeated enum.
 * @param repeat Packed or unpacked repetition.
 * @return The synthetic enum field descriptor.
 */
export function enumEnvelopeField(
  repeat: RepeatType.PACKED | RepeatType.UNPACKED
): FieldInfo {
  return {
    no: EpochIndexFieldNumber,
    name: "epoch_index",
    localName: "epochIndex",
    jsonName: "epochIndex",
    kind: "enum",
    T: () => TestEnumInfo,
    repeat,
    opt: false,
    oneof: undefined
  }
}

/**
 * Build a `FieldInfo` that redeclares field 1 as a `map<string, V>`.
 * @param value Descriptor for the map value; defaults to `uint32`.
 * @return The synthetic map field descriptor.
 */
export function mapEnvelopeField(
  value: MapValueInfo = { kind: "scalar", T: ScalarType.UINT32 }
): FieldInfo {
  return {
    no: EnvelopeHashFieldNumber,
    name: "envelope_hash",
    localName: "envelopeHash",
    jsonName: "envelopeHash",
    kind: "map",
    K: ScalarType.STRING,
    V: value,
    repeat: RepeatType.NO,
    opt: false,
    oneof: undefined
  }
}

/**
 * Run `action` with one Envelope descriptor field temporarily swapped.
 *
 * The generated descriptor carries no enum or map field, so the scanner's enum
 * and map branches can only be reached by substituting a synthetic descriptor;
 * the original is always restored.
 *
 * @param field Replacement descriptor, matched to an existing field by number.
 * @param action Work to run against the patched descriptor.
 * @return Whatever `action` returns.
 */
export function withEnvelopeField<T>(field: FieldInfo, action: () => T): T {
  const originalFields = Envelope.fields,
    replacementFields = originalFields.map(original =>
      original.no === field.no ? field : original
    )
  Reflect.set(Envelope, "fields", replacementFields)
  try {
    return action()
  } finally {
    Reflect.set(Envelope, "fields", originalFields)
  }
}
