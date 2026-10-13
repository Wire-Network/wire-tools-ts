import {
  JsonRPCErrorSchema,
  JsonRPCIdSchema,
  JsonRPCVersionSchema,
  JsonRPCProtocol,
  JsonRPCResponseEnvelopeSchema,
  JsonRPCResponseEnvelopeSchemaCodec,
  type JsonRPCResponseEnvelope
} from "@wireio/cluster-tool-shared"

describe("JsonRPCProtocol", () => {
  it("spells JSON-RPC 2.0 over an HTTP POST with JSON headers", () => {
    expect(JsonRPCProtocol.Version).toBe("2.0")
    expect(JsonRPCProtocol.HttpMethod).toBe("POST")
    expect(JsonRPCProtocol.RequestHeaders).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json"
    })
  })
})

describe("JsonRPCProtocol.ErrorCode", () => {
  it("spells the five standard JSON-RPC 2.0 error codes", () => {
    expect(JsonRPCProtocol.ErrorCode.PARSE_ERROR).toBe(-32700)
    expect(JsonRPCProtocol.ErrorCode.INVALID_REQUEST).toBe(-32600)
    expect(JsonRPCProtocol.ErrorCode.METHOD_NOT_FOUND).toBe(-32601)
    expect(JsonRPCProtocol.ErrorCode.INVALID_PARAMS).toBe(-32602)
    expect(JsonRPCProtocol.ErrorCode.INTERNAL_ERROR).toBe(-32603)
  })

  it("reverse-maps a code to its name and has no other members", () => {
    expect(JsonRPCProtocol.ErrorCode[-32601]).toBe("METHOD_NOT_FOUND")
    expect(Object.values(JsonRPCProtocol.ErrorCode).filter(value => typeof value === "number")).toHaveLength(5)
  })
})

describe("JsonRPCIdSchema / JsonRPCVersionSchema", () => {
  it("accepts a number, a string or null id", () => {
    ;[1, "abc", null].forEach(id => expect(JsonRPCIdSchema.safeParse(id).success).toBe(true))
  })

  it("rejects a non-scalar id", () => {
    ;[{}, [1], true].forEach(id => expect(JsonRPCIdSchema.safeParse(id).success).toBe(false))
  })

  it("accepts exactly the protocol version", () => {
    expect(JsonRPCVersionSchema.safeParse(JsonRPCProtocol.Version).success).toBe(true)
    expect(JsonRPCVersionSchema.safeParse("1.0").success).toBe(false)
  })
})

describe("JsonRPCErrorSchema", () => {
  it("accepts an error with and without opaque data", () => {
    expect(
      JsonRPCErrorSchema.safeParse({ code: -32601, message: "nope" }).success
    ).toBe(true)
    expect(
      JsonRPCErrorSchema.safeParse({
        code: -32602,
        message: "bad",
        data: { any: ["thing"] }
      }).success
    ).toBe(true)
  })

  it("rejects a non-numeric code", () => {
    expect(
      JsonRPCErrorSchema.safeParse({ code: "x", message: "bad" }).success
    ).toBe(false)
  })
})

describe("JsonRPCResponseEnvelopeSchemaCodec", () => {
  const success: JsonRPCResponseEnvelope = {
      jsonrpc: JsonRPCProtocol.Version,
      id: 1,
      result: { ok: true }
    },
    failure: JsonRPCResponseEnvelope = {
      jsonrpc: JsonRPCProtocol.Version,
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

  it("accepts a null id, a string id and an opaque result payload", () => {
    expect(
      JsonRPCResponseEnvelopeSchemaCodec.check({
        jsonrpc: JsonRPCProtocol.Version,
        id: null,
        result: 42
      })
    ).toBe(true)
    expect(
      JsonRPCResponseEnvelopeSchemaCodec.check({
        jsonrpc: JsonRPCProtocol.Version,
        id: "abc",
        result: null
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

  it("rejects any jsonrpc version other than 2.0", () => {
    expect(
      JsonRPCResponseEnvelopeSchemaCodec.check({
        jsonrpc: "1.0",
        id: 1,
        result: {}
      })
    ).toBe(false)
    expect(
      JsonRPCResponseEnvelopeSchema.safeParse({ jsonrpc: "2.1", id: 1 })
        .success
    ).toBe(false)
  })

  it("throws from deserialize on a version-mismatched envelope", () => {
    expect(() =>
      JsonRPCResponseEnvelopeSchemaCodec.deserialize(
        JSON.stringify({ jsonrpc: "1.0", id: 1 })
      )
    ).toThrow("validation failed")
  })
})
