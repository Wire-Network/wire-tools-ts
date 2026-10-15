import { NestedError } from "@wireio/shared"

import {
  QueryEngineError,
  QueryErrorCode,
  QueryErrorKind,
  QueryFailure,
  QueryFailureError,
  QueryFailureKind,
  QueryTransportError
} from "@wireio/ql-shared"

import { createEngineError } from "../common/errorFixtures.js"

describe("QueryEngineError", () => {
  it("carries the engine fields, the cause and a folded context", () => {
    const cause = new Error("root"),
      data = { kind: QueryErrorKind.QUERY_LIMIT, retryable: false, line: null, column: null, limit: "query-max-scan-rows" },
      error = new QueryEngineError("Query resource limit exceeded", {
        code: QueryErrorCode.QUERY_LIMIT,
        data,
        requestId: "r-1",
        cause
      })
    expect(error).toBeInstanceOf(NestedError)
    expect(error.name).toBe("QueryEngineError")
    expect(error).toMatchObject({
      code: QueryErrorCode.QUERY_LIMIT,
      data,
      requestId: "r-1",
      engineMessage: "Query resource limit exceeded"
    })
    expect(error.cause).toBe(cause)
    expect(error.context).toEqual({ kind: "QUERY_LIMIT", code: -32012, limit: "query-max-scan-rows", requestId: "r-1" })
    expect(error.message).toContain("query-max-scan-rows")
  })

  it("works without a cause", () => {
    const error = createEngineError(QueryErrorKind.QUERY_SYNTAX, { message: "bad", data: { line: 1, column: 32 } })
    expect(error.causes).toEqual([])
    expect(error.data.column).toBe(32)
    expect(error.engineMessage).toBe("bad")
  })
})

describe("QueryTransportError", () => {
  it("carries url, status, request id, detail and cause", () => {
    const cause = new TypeError("fetch failed"),
      error = new QueryTransportError("request failed", { url: "http://x/v1/query/execute", status: null, requestId: "r", cause })
    expect(error).toMatchObject({ url: "http://x/v1/query/execute", status: null, requestId: "r", detail: "request failed", name: "QueryTransportError" })
    expect(error.cause).toBe(cause)
  })

  it("works without a cause", () => {
    expect(new QueryTransportError("HTTP 500", { url: "u", status: 500, requestId: "r" }).causes).toEqual([])
  })
})

describe("QueryFailureError", () => {
  it("carries its failure unchanged, names itself and folds only the given context into the message", () => {
    const failure = QueryFailure.transport("query host exited"),
      cause = new Error("port closed"),
      error = new QueryFailureError("call failed", { failure, cause, context: { requestId: "r" } })
    expect(error).toBeInstanceOf(NestedError)
    expect(error.name).toBe("QueryFailureError")
    expect(error.failure).toBe(failure)
    expect(error.causes).toEqual([cause])
    expect(error.message).toBe("call failed (requestId=r)")
    expect(error.context).toEqual({ requestId: "r" })
    expect(error.failure.kind).toBe(QueryFailureKind.transport)
  })

  it("needs no cause or extra context", () => {
    const error = new QueryFailureError("x", { failure: QueryFailure.transport("x") })
    expect(error.causes).toEqual([])
    expect(error.message).toBe("x")
  })
})
