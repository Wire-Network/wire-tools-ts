import {
  DebugEnvelopeMetadataRecord,
  Envelope
} from "@wireio/opp-typescript-models"

import { decodeCanonicalMessage } from "@wireio/debugging-shared"

import {
  canonicalEnvelopeBytes,
  concatFieldBytes,
  encodeProtobufVarint,
  lengthDelimitedField,
  varintField
} from "./canonicalDecodeTestSupport.js"

const EnvelopeEpoch = 7,
  EnvelopeHashFieldNumber = 1,
  EpochIndexFieldNumber = 6,
  MetadataChecksumFieldNumber = 1,
  PaddingByteLength = 4_096

describe("decodeCanonicalMessage", () => {
  it("decodes a canonical envelope unchanged", () => {
    // Given: bytes produced by the generated serializer.
    const bytes = canonicalEnvelopeBytes(EnvelopeEpoch)

    // When: the strict decoder reads them.
    const envelope = decodeCanonicalMessage(Envelope, bytes)

    // Then: the decoded message matches the canonical values.
    expect(envelope.epochIndex).toBe(EnvelopeEpoch)
    expect(envelope.epochTimestamp).toBe(1n)
  })

  it("accepts a legitimately repeated field occurring many times", () => {
    // Given: metadata whose repeated batch_op_names field is encoded three times.
    const bytes = DebugEnvelopeMetadataRecord.toBinary(
      DebugEnvelopeMetadataRecord.create({
        checksum: 1n,
        batchOpNames: ["batchop.a", "batchop.b", "batchop.c"]
      })
    )

    // When: the strict decoder reads them.
    const decoded = decodeCanonicalMessage(DebugEnvelopeMetadataRecord, bytes)

    // Then: every repeated value survives and nothing is rejected.
    expect(decoded.batchOpNames).toEqual([
      "batchop.a",
      "batchop.b",
      "batchop.c"
    ])
  })

  it("rejects a repeated singular length-delimited field used as padding", () => {
    // Given: a duplicate of singular field 1 padding the canonical bytes.
    const forged = concatFieldBytes([
      lengthDelimitedField(EnvelopeHashFieldNumber, PaddingByteLength),
      canonicalEnvelopeBytes(EnvelopeEpoch)
    ])

    // Then: the padded encoding is rejected even though it decodes tolerantly.
    expect(Envelope.fromBinary(forged).epochIndex).toBe(EnvelopeEpoch)
    expect(() => decodeCanonicalMessage(Envelope, forged)).toThrow(
      /repeats singular field 1/
    )
  })

  it("rejects a repeated singular varint field", () => {
    // Given: the canonical bytes preceded by a duplicate epoch_index varint.
    const forged = concatFieldBytes([
      varintField(EpochIndexFieldNumber, EnvelopeEpoch + 1),
      canonicalEnvelopeBytes(EnvelopeEpoch)
    ])

    // Then: last-one-wins decoding does not launder the duplicate field.
    expect(() => decodeCanonicalMessage(Envelope, forged)).toThrow(
      /repeats singular field 6/
    )
  })

  it("rejects a repeated singular metadata field", () => {
    // Given: metadata bytes preceded by a duplicate checksum field.
    const canonical = DebugEnvelopeMetadataRecord.toBinary(
      DebugEnvelopeMetadataRecord.create({
        checksum: 2n,
        batchOpNames: ["batchop.a"]
      })
    ),
      forged = concatFieldBytes([
        varintField(MetadataChecksumFieldNumber, 1),
        canonical
      ])

    // Then: the metadata sidecar is rejected on the same rule as envelope data.
    expect(() =>
      decodeCanonicalMessage(DebugEnvelopeMetadataRecord, forged)
    ).toThrow(/repeats singular field 1/)
  })

  it("rejects an unknown field number", () => {
    // Given: canonical bytes carrying a field the descriptor does not declare.
    const forged = concatFieldBytes([
      canonicalEnvelopeBytes(EnvelopeEpoch),
      lengthDelimitedField(500, PaddingByteLength)
    ])

    // Then: unknown-field rejection is preserved by the canonical decoder.
    expect(() => decodeCanonicalMessage(Envelope, forged)).toThrow()
  })

  it("rejects group wire encodings", () => {
    // Given: canonical bytes followed by a start-group tag.
    const startGroupTag = encodeProtobufVarint((3 << 3) | 3),
      forged = concatFieldBytes([
        canonicalEnvelopeBytes(EnvelopeEpoch),
        startGroupTag
      ])

    // Then: the deprecated group encoding is refused outright.
    expect(() => decodeCanonicalMessage(Envelope, forged)).toThrow(
      /unsupported group encoding/
    )
  })
})
