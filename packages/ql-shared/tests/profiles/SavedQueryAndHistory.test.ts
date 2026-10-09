import {
  QueryEngineClient,
  QueryErrorKind,
  QueryExecutionStatus,
  QueryHistoryEntry,
  QueryHistoryEntryCodec,
  QueryOutcome,
  SavedQueriesDocument,
  SavedQueriesDocumentCodec,
  SavedQueryCodec,
  QueryTransportError,
  type QueryExecution,
  type QueryFailure
} from "@wireio/ql-shared"

import { createEngineError } from "../common/errorFixtures.js"
import { createResult, createSuccess, SampleColumns, SampleRows } from "../common/resultFixtures.js"

const now = "2026-10-07T12:00:00.000Z"

describe("SavedQuery", () => {
  it("round-trips a saved query and the document", () => {
    const saved = { id: "1", name: "ops", query: "SELECT * FROM \"sysio.opreg\".operators", createdAt: now, updatedAt: now }
    expect(SavedQueryCodec.deserialize(SavedQueryCodec.serialize(saved))).toEqual(saved)
    expect(SavedQueriesDocumentCodec.check({ queries: [saved] })).toBe(true)
    expect(SavedQueriesDocument.empty()).toEqual({ queries: [] })
  })

  it("rejects an empty query or a bad timestamp", () => {
    expect(SavedQueryCodec.check({ id: "1", name: "n", query: "", createdAt: now, updatedAt: now })).toBe(false)
    expect(SavedQueryCodec.check({ id: "1", name: "n", query: "q", createdAt: "yesterday", updatedAt: now })).toBe(false)
  })
})

describe("QueryHistoryEntry / QueryOutcome", () => {
  it("round-trips success and engine-error entries", () => {
    const success = { id: "r", profile: "p", query: "q", executedAt: now, outcome: QueryOutcome.success, errorKind: null, returnedRows: 3, wallTimeMs: 1.5 },
      failure = { ...success, outcome: QueryOutcome.engineError, errorKind: QueryErrorKind.QUERY_SYNTAX, returnedRows: null }
    expect(QueryHistoryEntryCodec.deserialize(QueryHistoryEntryCodec.serialize(success))).toEqual(success)
    expect(QueryHistoryEntryCodec.deserialize(QueryHistoryEntryCodec.serialize(failure))).toEqual(failure)
    expect(Object.values(QueryOutcome)).toEqual(["success", "engineError", "transportError", "cancelled"])
  })

  it("rejects an unknown outcome or negative rows", () => {
    const base = { id: "r", profile: "p", query: "q", executedAt: now, outcome: "maybe", errorKind: null, returnedRows: 1, wallTimeMs: 1 }
    expect(QueryHistoryEntryCodec.check(base)).toBe(false)
    expect(QueryHistoryEntryCodec.check({ ...base, outcome: QueryOutcome.success, returnedRows: -1 })).toBe(false)
  })
})

/** A failed execution carrying `failure`. */
function failedExecution(failure: QueryFailure): QueryExecution {
  return { status: QueryExecutionStatus.failure, requestId: "r-9", query: "SELECT 9", wallTimeMs: 4, attempts: 1, failure }
}

describe("QueryHistoryEntry.outcomeOf", () => {
  it("maps success and every failure class", () => {
    expect(QueryHistoryEntry.outcomeOf(createSuccess(createResult(SampleColumns, SampleRows)))).toBe(QueryOutcome.success)
    expect(QueryHistoryEntry.outcomeOf(failedExecution(QueryEngineClient.engineFailure(createEngineError())))).toBe(QueryOutcome.engineError)
    expect(
      QueryHistoryEntry.outcomeOf(failedExecution(QueryEngineClient.transportFailure(new QueryTransportError("HTTP 500", { url: "u", status: 500, requestId: "r" }))))
    ).toBe(QueryOutcome.transportError)
    expect(QueryHistoryEntry.outcomeOf(failedExecution(QueryEngineClient.cancelledFailure()))).toBe(QueryOutcome.cancelled)
  })
})

describe("QueryHistoryEntry.of", () => {
  const at = new Date(now)

  it("records a success with its returned rows and no error kind", () => {
    const success = createSuccess(createResult(SampleColumns, SampleRows)),
      entry = QueryHistoryEntry.of(success, "local", at)
    expect(entry).toEqual({
      id: success.requestId,
      profile: "local",
      query: success.query,
      executedAt: now,
      outcome: QueryOutcome.success,
      errorKind: null,
      returnedRows: Number(success.result.page.returned_rows),
      wallTimeMs: success.wallTimeMs
    })
    expect(QueryHistoryEntryCodec.check(entry)).toBe(true)
  })

  it("records an engine failure's kind and a non-engine failure's null kind", () => {
    const engine = QueryHistoryEntry.of(failedExecution(QueryEngineClient.engineFailure(createEngineError(QueryErrorKind.QUERY_BUSY))), "p", at),
      cancelled = QueryHistoryEntry.of(failedExecution(QueryEngineClient.cancelledFailure()), "p", at)
    expect(engine).toMatchObject({ outcome: QueryOutcome.engineError, errorKind: QueryErrorKind.QUERY_BUSY, returnedRows: null, wallTimeMs: 4 })
    expect(cancelled).toMatchObject({ outcome: QueryOutcome.cancelled, errorKind: null, returnedRows: null })
    expect(QueryHistoryEntryCodec.check(engine)).toBe(true)
    expect(QueryHistoryEntryCodec.check(cancelled)).toBe(true)
  })
})
