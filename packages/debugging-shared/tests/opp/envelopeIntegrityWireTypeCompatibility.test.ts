import { RepeatType, ScalarType } from "@protobuf-ts/runtime"
import { Envelope } from "@wireio/opp-typescript-models"

import {
  decodeCanonicalMessage,
  NonCanonicalEnvelopeProtobufError
} from "@wireio/debugging-shared"

import {
  enumEnvelopeField,
  mapEnvelopeField,
  scalarEnvelopeField,
  withEnvelopeField
} from "./canonicalDecodeDescriptorSupport.js"

/**
 * Single-value wire-type witnesses, one per scalar family. Each carries the
 * canonical tag for field 6 (`epoch_index`) so the descriptor swap below only
 * has to vary the declared scalar type, never the bytes.
 */
const VarintFieldBytes = Buffer.from([0x30, 0x00]),
  Bit64FieldBytes = Buffer.from([
    0x31, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00
  ]),
  LengthDelimitedFieldBytes = Buffer.from([0x32, 0x00]),
  Bit32FieldBytes = Buffer.from([0x35, 0x80, 0x80, 0x80, 0x00])

describe("decodeCanonicalMessage wire-type compatibility", () => {
  it.each([
    [ScalarType.INT32, VarintFieldBytes],
    [ScalarType.INT64, VarintFieldBytes],
    [ScalarType.UINT32, VarintFieldBytes],
    [ScalarType.UINT64, VarintFieldBytes],
    [ScalarType.SINT32, VarintFieldBytes],
    [ScalarType.SINT64, VarintFieldBytes],
    [ScalarType.BOOL, VarintFieldBytes],
    [ScalarType.FIXED64, Bit64FieldBytes],
    [ScalarType.SFIXED64, Bit64FieldBytes],
    [ScalarType.DOUBLE, Bit64FieldBytes],
    [ScalarType.STRING, LengthDelimitedFieldBytes],
    [ScalarType.BYTES, LengthDelimitedFieldBytes],
    [ScalarType.FIXED32, Bit32FieldBytes],
    [ScalarType.SFIXED32, Bit32FieldBytes],
    [ScalarType.FLOAT, Bit32FieldBytes]
  ])("accepts descriptor-compatible scalar type %s", (type, bytes) => {
    // Given: field 6 is described by the selected scalar wire family.
    const field = scalarEnvelopeField(type)

    // When/Then: strict scanning and generated decoding consume the same bytes.
    expect(() =>
      withEnvelopeField(field, () => decodeCanonicalMessage(Envelope, bytes))
    ).not.toThrow()
  })

  it.each([
    [ScalarType.UINT32, LengthDelimitedFieldBytes],
    [ScalarType.FIXED64, VarintFieldBytes],
    [ScalarType.BYTES, VarintFieldBytes],
    [ScalarType.FLOAT, Bit64FieldBytes]
  ])(
    "rejects a singular scalar type %s arriving with the wrong wire type",
    (type, bytes) => {
      // Given: field 6 declares a scalar whose canonical wire type these bytes miss.
      const field = scalarEnvelopeField(type)

      // When/Then: the incompatible wire type is refused before the backstop.
      expect(() =>
        withEnvelopeField(field, () => decodeCanonicalMessage(Envelope, bytes))
      ).toThrow(/incompatible wire type/)
    }
  )

  it.each([
    [
      "unpacked numeric with unpacked descriptor",
      scalarEnvelopeField(ScalarType.UINT32, RepeatType.UNPACKED),
      Buffer.from([0x30, 0x01, 0x30, 0x02])
    ],
    [
      "packed numeric with unpacked descriptor",
      scalarEnvelopeField(ScalarType.UINT32, RepeatType.UNPACKED),
      LengthDelimitedFieldBytes
    ],
    [
      "unpacked enum with packed descriptor",
      enumEnvelopeField(RepeatType.PACKED),
      Buffer.from([0x30, 0x01, 0x30, 0x02])
    ],
    [
      "packed enum with unpacked descriptor",
      enumEnvelopeField(RepeatType.UNPACKED),
      LengthDelimitedFieldBytes
    ]
  ])("accepts %s", (_label, field, bytes) => {
    // Given: a repeated numeric or enum field uses either legal representation.

    // When/Then: RepeatType does not prohibit the alternate wire representation.
    expect(() =>
      withEnvelopeField(field, () => decodeCanonicalMessage(Envelope, bytes))
    ).not.toThrow()
  })

  it("accepts matching synthetic map key and value wire types", () => {
    // Given: field 1 is a map<string, uint32> with one complete entry.
    const bytes = Buffer.from([0x0a, 0x05, 0x0a, 0x01, 0x61, 0x10, 0x01])

    // When/Then: the outer map, key, and value framing are compatible.
    expect(() =>
      withEnvelopeField(mapEnvelopeField(), () =>
        decodeCanonicalMessage(Envelope, bytes)
      )
    ).not.toThrow()
  })

  it("accepts repeated synthetic map entries without key deduplication", () => {
    // Given: field 1 contains the same valid map entry twice.
    const entry = Buffer.from([0x0a, 0x05, 0x0a, 0x01, 0x61, 0x10, 0x01]),
      bytes = Buffer.concat([entry, entry])

    // When/Then: map outer occurrences and repeated keys remain protobuf-valid.
    expect(() =>
      withEnvelopeField(mapEnvelopeField(), () =>
        decodeCanonicalMessage(Envelope, bytes)
      )
    ).not.toThrow()
  })

  it.each([
    ["key", Buffer.from([0x0a, 0x02, 0x08, 0x00])],
    ["value", Buffer.from([0x0a, 0x02, 0x12, 0x00])]
  ])("rejects an incompatible synthetic map %s wire type", (_label, bytes) => {
    // Given: a map<string, uint32> entry frames one synthetic field incorrectly.

    // When/Then: map-entry consumption rejects before skipping the known value.
    expect(() =>
      withEnvelopeField(mapEnvelopeField(), () =>
        decodeCanonicalMessage(Envelope, bytes)
      )
    ).toThrow(/incompatible wire type/)
  })

  it("rejects a duplicate synthetic map key", () => {
    // Given: one map entry encodes the singular key field 1 twice.
    const bytes = Buffer.from([0x0a, 0x06, 0x0a, 0x01, 0x61, 0x0a, 0x01, 0x62])

    // When/Then: map-entry key cardinality matches top-level singular cardinality.
    expect(() =>
      withEnvelopeField(mapEnvelopeField(), () =>
        decodeCanonicalMessage(Envelope, bytes)
      )
    ).toThrow(/map entry repeats singular field 1/)
  })

  it("throws a NonCanonicalEnvelopeProtobufError for a structural rejection", () => {
    // Given: field 6 (a varint scalar) arrives length-delimited.
    const bytes = LengthDelimitedFieldBytes

    // Then: the rejection is the named integrity subclass, not a bare Error.
    expect(() => decodeCanonicalMessage(Envelope, bytes)).toThrow(
      NonCanonicalEnvelopeProtobufError
    )
  })
})
