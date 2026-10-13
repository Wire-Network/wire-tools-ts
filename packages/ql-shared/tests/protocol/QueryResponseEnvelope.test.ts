import {
  QueryEngineErrorSchema,
  QueryErrorDataSchema,
  QueryResponseEnvelopeCodec,
  QueryResponseErrorEnvelopeSchema,
  QueryResponseSuccessEnvelopeSchema
} from "@wireio/ql-shared"

import { readEngineExample } from "../common/resultFixtures.js"

describe("QueryResponseEnvelope", () => {
  it("decodes the error example as the error variant", () => {
    const envelope = JSON.parse(readEngineExample("error.json"))
    expect(QueryResponseErrorEnvelopeSchema.safeParse(envelope).success).toBe(true)
    expect(QueryResponseSuccessEnvelopeSchema.safeParse(envelope).success).toBe(false)
    expect(QueryResponseEnvelopeCodec.deserialize(readEngineExample("error.json"))).toEqual(envelope)
  })

  it("accepts null line/column and rejects an unknown kind or code", () => {
    const data = { kind: "QUERY_SYNTAX", retryable: false, line: null, column: null, limit: null }
    expect(QueryErrorDataSchema.safeParse(data).success).toBe(true)
    expect(QueryErrorDataSchema.safeParse({ ...data, kind: "NOPE" }).success).toBe(false)
    expect(QueryErrorDataSchema.safeParse({ ...data, line: 0 }).success).toBe(false)
    expect(QueryEngineErrorSchema.safeParse({ code: -1, message: "x", data }).success).toBe(false)
  })

  it("rejects a wrong jsonrpc and a body carrying both result and error", () => {
    const envelope = JSON.parse(readEngineExample("error.json"))
    expect(QueryResponseEnvelopeCodec.check({ ...envelope, jsonrpc: "1.0" })).toBe(false)
    const success = JSON.parse(readEngineExample("response.json"))
    expect(QueryResponseEnvelopeCodec.check({ ...success, error: envelope.error })).toBe(false)
  })
})
