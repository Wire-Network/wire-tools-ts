import {
  LogicalType,
  QueryEngineMethod,
  QueryEngineRPC,
  QueryErrorCode,
  QueryErrorKind,
  ValueEncoding
} from "@wireio/ql-shared"

/** Identity string enums: value === key. */
const identityEnums = { LogicalType, ValueEncoding, QueryErrorKind, QueryEngineMethod }

describe("protocol constants and enums", () => {
  it("spells the engine endpoint, schema version and request bounds", () => {
    expect(QueryEngineRPC.ExecutePath).toBe("/v1/query/execute")
    expect(QueryEngineRPC.SchemaVersion).toBe("1.1")
    expect(QueryEngineRPC.MaxStringIdLength).toBe(128)
    expect(QueryEngineRPC.MaxIntegerId).toBe(4294967295)
    expect(QueryEngineRPC.MaxRequestInteger).toBe(9007199254740991)
    expect(QueryEngineRPC.MinRequestTimeoutMs).toBe(1)
  })

  it.each(Object.entries(identityEnums))("%s is an identity enum", (_name, values) => {
    Object.entries(values).forEach(([key, value]) => expect(value).toBe(key))
  })

  it("maps every error kind to its JSON-RPC code (engine README table)", () => {
    expect(Object.keys(QueryErrorKind).sort()).toEqual(
      Object.keys(QueryErrorCode).filter(key => Number.isNaN(Number(key))).sort()
    )
    expect(QueryErrorCode.PARSE_ERROR).toBe(-32700)
    expect(QueryErrorCode.INVALID_PARAMS).toBe(-32602)
    expect(QueryErrorCode.QUERY_SYNTAX).toBe(-32010)
    expect(QueryErrorCode.QUERY_CANCELLED).toBe(-32019)
    expect(QueryErrorCode.INTERNAL_ERROR).toBe(-32603)
  })

  it("has no reverse-mapping string member for an unknown kind", () => {
    expect((QueryErrorKind as Record<string, string>)["NOT_A_KIND"]).toBeUndefined()
  })
})
