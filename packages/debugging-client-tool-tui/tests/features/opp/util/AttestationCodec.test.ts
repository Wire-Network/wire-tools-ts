import {
  AttestationType,
  BatchOperatorGroups,
  type AttestationEntry
} from "@wireio/opp-typescript-models"
import {
  AttestationDecoders,
  decodeAttestation,
  jsonSafe
} from "@wire-e2e-tests/debugging-client-tool-tui/features/opp/util/AttestationCodec.js"

/**
 * Encode a small `BatchOperatorGroups` as protobuf bytes — used to drive a
 * realistic decode path through `decodeAttestation`. Empty `groups` is the
 * minimal valid shape.
 */
function encodeBatchOperatorGroups(): Uint8Array {
  return BatchOperatorGroups.toBinary({
    activeGroupIndex: 0,
    epochIndex: 0,
    groups: []
  })
}

describe("AttestationDecoders registry", () => {
  it("registers the BatchOperatorGroups class for BATCH_OPERATOR_GROUPS", () => {
    expect(AttestationDecoders[AttestationType.BATCH_OPERATOR_GROUPS]).toBe(
      BatchOperatorGroups
    )
  })

  it("does not register a decoder for UNSPECIFIED", () => {
    expect(AttestationDecoders[AttestationType.UNSPECIFIED]).toBeUndefined()
  })

  it("every registered decoder exposes a `fromBinary` method", () => {
    Object.values(AttestationDecoders).forEach(decoder => {
      expect(typeof decoder?.fromBinary).toBe("function")
      expect(typeof decoder?.typeName).toBe("string")
    })
  })
})

describe("decodeAttestation", () => {
  it("returns a `decoded` discriminator when the type has a decoder", () => {
    const bytes = encodeBatchOperatorGroups(),
      entry: AttestationEntry = {
        type: AttestationType.BATCH_OPERATOR_GROUPS,
        dataSize: bytes.length,
        data: bytes
      }
    const result = decodeAttestation(entry)
    expect(result.kind).toBe("decoded")
    if (result.kind !== "decoded") return
    expect(result.typeName).toBe(BatchOperatorGroups.typeName)
  })

  it("accepts base64-encoded `data` from the Redux-serialized envelope", () => {
    const bytes = encodeBatchOperatorGroups(),
      entry = {
        type: AttestationType.BATCH_OPERATOR_GROUPS,
        dataSize: bytes.length,
        data: Buffer.from(bytes).toString("base64")
      } as unknown as AttestationEntry
    const result = decodeAttestation(entry)
    expect(result.kind).toBe("decoded")
  })

  it("falls back to `raw` when no decoder is registered for the type", () => {
    const entry: AttestationEntry = {
      type: AttestationType.UNSPECIFIED,
      dataSize: 0,
      data: new Uint8Array()
    }
    const result = decodeAttestation(entry)
    expect(result.kind).toBe("raw")
    if (result.kind !== "raw") return
    expect(result.reason).toMatch(/no decoder/)
  })

  it("falls back to `raw` when decode throws on bogus bytes", () => {
    const entry: AttestationEntry = {
      type: AttestationType.BATCH_OPERATOR_GROUPS,
      dataSize: 4,
      data: new Uint8Array([0xff, 0xff, 0xff, 0xff])
    }
    const result = decodeAttestation(entry)
    expect(result.kind).toBe("raw")
    if (result.kind !== "raw") return
    expect(result.reason).toMatch(/decode failed/)
  })

  it("recovers bytes from the legacy { type: 'Buffer', data: number[] } shape", () => {
    // What older Buffer-toJSON-leaked code paths leave in Redux. The decoder
    // should still produce a typed message rather than fall to `raw`.
    const bytes = encodeBatchOperatorGroups(),
      bufferShape = {
        type: "Buffer",
        data: Array.from(bytes)
      },
      entry = {
        type: AttestationType.BATCH_OPERATOR_GROUPS,
        dataSize: bytes.length,
        data: bufferShape
      } as unknown as AttestationEntry
    const result = decodeAttestation(entry)
    expect(result.kind).toBe("decoded")
  })
})

describe("jsonSafe", () => {
  it("stringifies BigInt fields", () => {
    expect(jsonSafe({ x: BigInt(42) })).toEqual({ x: "42" })
  })

  it("base64-encodes Uint8Array fields", () => {
    expect(jsonSafe({ x: new Uint8Array([0xde, 0xad, 0xbe, 0xef]) })).toEqual({
      x: "3q2+7w=="
    })
  })

  it("base64-encodes Buffer fields (Buffer.toJSON would otherwise mask them)", () => {
    // Buffer extends Uint8Array; Buffer.prototype.toJSON used to win over
    // the JSON.stringify replacer. The recursive walk catches it directly.
    expect(jsonSafe({ x: Buffer.from([0xde, 0xad, 0xbe, 0xef]) })).toEqual({
      x: "3q2+7w=="
    })
  })

  it("recurses through nested arrays + objects", () => {
    expect(
      jsonSafe({
        outer: {
          list: [Buffer.from([0x01, 0x02]), { nested: BigInt(99) }]
        }
      })
    ).toEqual({
      outer: {
        list: ["AQI=", { nested: "99" }]
      }
    })
  })

  it("passes plain JSON values through unchanged", () => {
    expect(jsonSafe({ a: 1, b: "hi", c: [true, null] })).toEqual({
      a: 1,
      b: "hi",
      c: [true, null]
    })
  })
})
