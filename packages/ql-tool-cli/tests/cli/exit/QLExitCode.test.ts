import { QueryErrorKind, QueryFailureKind } from "@wireio/ql-shared"

import { QLExitCode } from "@wireio/ql-tool-cli/cli/index.js"

import { createFailure } from "../../common/engineFixtures.js"

describe("QLExitCode", () => {
  it.each([
    [QueryErrorKind.QUERY_SYNTAX, QLExitCode.querySyntax, 10],
    [QueryErrorKind.QUERY_SEMANTICS, QLExitCode.querySemantics, 11],
    [QueryErrorKind.QUERY_LIMIT, QLExitCode.queryLimit, 12],
    [QueryErrorKind.QUERY_TIMEOUT, QLExitCode.queryTimeout, 13],
    [QueryErrorKind.QUERY_BUSY, QLExitCode.queryBusy, 14],
    [QueryErrorKind.SCHEMA_CHANGED, QLExitCode.schemaChanged, 15],
    [QueryErrorKind.ROW_DECODE_ERROR, QLExitCode.rowDecode, 16],
    [QueryErrorKind.VALUE_ERROR, QLExitCode.value, 17],
    [QueryErrorKind.STATE_UNAVAILABLE, QLExitCode.stateUnavailable, 18],
    [QueryErrorKind.QUERY_CANCELLED, QLExitCode.cancelled, 19],
    [QueryErrorKind.PARSE_ERROR, QLExitCode.protocol, 20],
    [QueryErrorKind.INVALID_REQUEST, QLExitCode.protocol, 20],
    [QueryErrorKind.METHOD_NOT_FOUND, QLExitCode.protocol, 20],
    [QueryErrorKind.INVALID_PARAMS, QLExitCode.protocol, 20],
    [QueryErrorKind.INTERNAL_ERROR, QLExitCode.internal, 21]
  ])("maps %s to %s (%d)", (kind, code, numeric) => {
    expect(QLExitCode.forKind(kind)).toBe(code)
    expect(code).toBe(numeric)
  })

  it("maps every engine kind (exhaustive)", () => {
    Object.values(QueryErrorKind).forEach(kind => expect(QLExitCode.forKind(kind)).toBeGreaterThanOrEqual(QLExitCode.querySyntax))
  })

  it("maps failures: engine by kind, transport, cancelled", () => {
    expect(QLExitCode.forFailure(createFailure({ data: { kind: QueryErrorKind.QUERY_LIMIT } }))).toBe(QLExitCode.queryLimit)
    expect(QLExitCode.forFailure(createFailure({ kind: QueryFailureKind.transport }))).toBe(QLExitCode.transport)
    expect(QLExitCode.forFailure(createFailure({ kind: QueryFailureKind.cancelled }))).toBe(QLExitCode.cancelled)
  })

  it("documents the fixed process codes", () => {
    expect([QLExitCode.success, QLExitCode.failure, QLExitCode.usage, QLExitCode.transport, QLExitCode.interrupted]).toEqual([0, 1, 2, 3, 130])
  })
})
