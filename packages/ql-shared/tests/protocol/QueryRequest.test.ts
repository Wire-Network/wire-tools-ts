import {
  QueryEngineMethod,
  QueryEngineRPC,
  QueryRequestCodec,
  QueryRequestIdSchema,
  QueryRequestParamsSchema,
  type QueryRequest
} from "@wireio/ql-shared"

const request = (params: object, id: unknown = "q-1"): unknown => ({
  jsonrpc: "2.0",
  id,
  method: QueryEngineMethod["query.execute"],
  params
})

describe("QueryRequest", () => {
  it("serializes exactly {query} for a plain query", () => {
    const value: QueryRequest = { jsonrpc: "2.0", id: "q-1", method: QueryEngineMethod["query.execute"], params: { query: "SELECT x FROM a.b" } }
    expect(JSON.parse(QueryRequestCodec.serialize(value)).params).toEqual({ query: "SELECT x FROM a.b" })
  })

  it("accepts limit / offset / timeout_ms when given", () => {
    expect(
      QueryRequestParamsSchema.parse({ query: "SELECT x FROM a.b", limit: 0, offset: 5, timeout_ms: 1 })
    ).toEqual({ query: "SELECT x FROM a.b", limit: 0, offset: 5, timeout_ms: 1 })
    expect(QueryRequestCodec.check(request({ query: "q", limit: QueryEngineRPC.MaxRequestInteger }))).toBe(true)
  })

  it("rejects out-of-range and unknown params", () => {
    ;[
      { query: "" },
      { query: "q", limit: -1 },
      { query: "q", limit: 1.5 },
      { query: "q", offset: QueryEngineRPC.MaxRequestInteger + 1 },
      { query: "q", timeout_ms: 0 },
      { query: "q", owner: "sample" }
    ].forEach(params => expect(QueryRequestCodec.check(request(params))).toBe(false))
  })

  it("bounds the id like the engine", () => {
    expect(QueryRequestIdSchema.safeParse("x".repeat(128)).success).toBe(true)
    expect(QueryRequestIdSchema.safeParse("x".repeat(129)).success).toBe(false)
    expect(QueryRequestIdSchema.safeParse(-4294967295).success).toBe(true)
    expect(QueryRequestIdSchema.safeParse(4294967296).success).toBe(false)
    expect(QueryRequestIdSchema.safeParse(null).success).toBe(true)
    expect(QueryRequestCodec.check({ jsonrpc: "2.0", method: "query.execute", params: { query: "q" } })).toBe(true)
  })

  it("rejects a wrong method or jsonrpc version", () => {
    expect(QueryRequestCodec.check({ ...(request({ query: "q" }) as object), method: "query.other" })).toBe(false)
    expect(QueryRequestCodec.check({ ...(request({ query: "q" }) as object), jsonrpc: "1.0" })).toBe(false)
  })
})
