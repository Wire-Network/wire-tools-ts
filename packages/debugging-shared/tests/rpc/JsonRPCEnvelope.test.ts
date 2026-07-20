import {
  JsonRPCResponseEnvelopeSchemaCodec,
  type JsonRPCResponseEnvelope
} from "@wireio/debugging-shared"

describe("JsonRPCResponseEnvelopeSchemaCodec", () => {
  const success: JsonRPCResponseEnvelope = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true }
    },
    failure: JsonRPCResponseEnvelope = {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "method not found" }
    }

  it("round-trips success + error envelopes through serialize → deserialize", () => {
    ;[success, failure].forEach(envelope =>
      expect(
        JsonRPCResponseEnvelopeSchemaCodec.deserialize(
          JsonRPCResponseEnvelopeSchemaCodec.serialize(envelope)
        )
      ).toEqual(envelope)
    )
  })

  it("accepts a null id and an opaque result payload", () => {
    expect(
      JsonRPCResponseEnvelopeSchemaCodec.check({
        jsonrpc: "2.0",
        id: null,
        result: 42
      })
    ).toBe(true)
  })

  it("rejects non-envelopes and wrong-typed envelope fields", () => {
    expect(JsonRPCResponseEnvelopeSchemaCodec.check(null)).toBe(false)
    // Missing the required jsonrpc field.
    expect(JsonRPCResponseEnvelopeSchemaCodec.check({ id: 1 })).toBe(false)
    // jsonrpc is not a string.
    expect(
      JsonRPCResponseEnvelopeSchemaCodec.check({ jsonrpc: 2, id: 1 })
    ).toBe(false)
  })
})
