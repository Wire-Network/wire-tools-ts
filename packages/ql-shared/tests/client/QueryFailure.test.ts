import { NestedError } from "@wireio/shared"

import {
  QueryEngineClient,
  QueryErrorKind,
  QueryFailure,
  QueryFailureError,
  QueryFailureKind,
  QueryTransportError
} from "@wireio/ql-shared"

import { createEngineError } from "../common/errorFixtures.js"

/** A transport error of the fixture endpoint. */
const transportError = () => new QueryTransportError("HTTP 503", { url: "http://node/v1/query/execute", status: 503, requestId: "r" })

/** An `AbortSignal` abort reason (`DOMException` named AbortError). */
const abortReason = () => {
  const controller = new AbortController()
  controller.abort()
  return controller.signal.reason
}

describe("QueryFailure.of", () => {
  it("dispatches engine, transport and abort errors to the QueryEngineClient builders", () => {
    const engine = createEngineError(QueryErrorKind.QUERY_BUSY, { data: { retryable: true } })
    expect(QueryFailure.of(engine)).toEqual(QueryEngineClient.engineFailure(engine))
    expect(QueryFailure.of(engine)).toMatchObject({ kind: QueryFailureKind.engine, data: { retryable: true } })
    expect(QueryFailure.of(transportError())).toEqual(QueryEngineClient.transportFailure(transportError()))
    expect(QueryFailure.of(abortReason())).toEqual(QueryEngineClient.cancelledFailure())
  })

  it("returns a QueryFailureError's own failure unchanged", () => {
    const failure = QueryEngineClient.engineFailure(createEngineError(QueryErrorKind.QUERY_LIMIT)),
      error = new QueryFailureError("describe failed", { failure, context: { owner: "o" } })
    expect(QueryFailure.of(error)).toBe(failure)
    expect(error.context).toEqual({ owner: "o" })
  })

  it("finds the first classified error in a NestedError's cause chain", () => {
    const engine = createEngineError(QueryErrorKind.QUERY_SEMANTICS),
      wrapped = new NestedError("outer", { cause: new NestedError("middle", { cause: engine }) })
    expect(QueryFailure.of(wrapped)).toEqual(QueryEngineClient.engineFailure(engine))
    const aborted = Object.assign(new Error("aborted"), { name: QueryFailure.AbortErrorName })
    expect(QueryFailure.of(new NestedError("loading the ABI failed", { cause: aborted }))).toEqual(
      QueryEngineClient.cancelledFailure()
    )
  })

  it("maps anything else (an unclassified NestedError, an Error, a thrown string) to a transport failure with its message", () => {
    expect(QueryFailure.of(new NestedError("loading failed", { cause: new Error("ECONNREFUSED") }))).toEqual(
      QueryFailure.transport("loading failed")
    )
    expect(QueryFailure.of(new Error("boom"))).toEqual({ kind: QueryFailureKind.transport, message: "boom", code: null, data: null })
    expect(QueryFailure.of("plain").message).toBe("plain")
  })

  it("transport builds a transport failure with explicit null engine fields", () => {
    expect(QueryFailure.transport("query host exited")).toEqual({
      kind: QueryFailureKind.transport,
      message: "query host exited",
      code: null,
      data: null
    })
    expect(structuredClone(QueryFailure.transport(""))).toEqual(QueryFailure.transport(""))
  })
})
