import { AttestationType, Envelope, Message } from "@wireio/opp-typescript-models"

import { decodeCanonicalMessage } from "@wireio/test-flow-swap-stress-saturation/envelope-integrity/index.js"

import {
  mapEnvelopeField,
  withEnvelopeField
} from "./canonicalDecodeDescriptorSupport.js"

describe("decodeCanonicalMessage nested recursion", () => {
  it("accepts generated nested messages and attestations", () => {
    // Given: generated writer output containing nested and repeated message fields.
    const bytes = Envelope.toBinary(
      Envelope.create({
        epochIndex: 1,
        endpoints: {},
        messages: [
          {
            header: { payloadSize: 1 },
            payload: {
              attestations: [
                {
                  type: AttestationType.UNSPECIFIED,
                  dataSize: 1,
                  data: Uint8Array.of(1)
                }
              ]
            }
          }
        ]
      })
    )

    // When: the strict decoder reads the exact writer bytes.
    const decoded = decodeCanonicalMessage(Envelope, bytes)

    // Then: nested writer output is accepted without normalization.
    expect(decoded.epochIndex).toBe(1)
    expect(decoded.messages[0]?.payload?.attestations).toHaveLength(1)
  })

  it("rejects a duplicate singular field inside a nested message", () => {
    // Given: field 2 (endpoints) carries field 1 (start) twice.
    const bytes = Buffer.from([0x12, 0x04, 0x0a, 0x00, 0x0a, 0x00])

    // When/Then: recursion enforces cardinality inside the nested Endpoints.
    expect(() => decodeCanonicalMessage(Envelope, bytes)).toThrow(
      /sysio\.opp\.Endpoints repeats singular field 1/
    )
  })

  it("rejects an incompatible wire type inside a nested message", () => {
    // Given: field 2 (endpoints) frames field 1 (a message) as a varint.
    const bytes = Buffer.from([0x12, 0x02, 0x08, 0x00])

    // When/Then: the nested message field's wire type is checked on recursion.
    expect(() => decodeCanonicalMessage(Envelope, bytes)).toThrow(
      /sysio\.opp\.Endpoints field 1 has incompatible wire type/
    )
  })

  it("rejects a duplicate singular field inside a repeated message element", () => {
    // Given: one element of repeated field 40 (messages) carries header twice.
    const bytes = Buffer.from([0xc2, 0x02, 0x04, 0x0a, 0x00, 0x0a, 0x00])

    // When/Then: each repeated element is scanned as its own nested message.
    expect(() => decodeCanonicalMessage(Envelope, bytes)).toThrow(
      /sysio\.opp\.Message repeats singular field 1/
    )
  })

  it("accepts a synthetic map entry whose message value is canonical", () => {
    // Given: field 1 is a map<string, Message> with one well-formed entry.
    const bytes = Buffer.from([
      0x0a, 0x07, 0x0a, 0x01, 0x61, 0x12, 0x02, 0x0a, 0x00
    ])

    // When/Then: the map value message recurses and passes the scan.
    expect(() =>
      withEnvelopeField(
        mapEnvelopeField({ kind: "message", T: () => Message }),
        () => decodeCanonicalMessage(Envelope, bytes)
      )
    ).not.toThrow()
  })

  it("rejects a duplicate singular field inside a map's message value", () => {
    // Given: the map value Message carries field 1 (header) twice.
    const bytes = Buffer.from([
      0x0a, 0x09, 0x0a, 0x01, 0x61, 0x12, 0x04, 0x0a, 0x00, 0x0a, 0x00
    ])

    // When/Then: recursion reaches the map value message and enforces cardinality.
    expect(() =>
      withEnvelopeField(
        mapEnvelopeField({ kind: "message", T: () => Message }),
        () => decodeCanonicalMessage(Envelope, bytes)
      )
    ).toThrow(/sysio\.opp\.Message repeats singular field 1/)
  })
})
