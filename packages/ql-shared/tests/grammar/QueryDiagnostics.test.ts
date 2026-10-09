import {
  QueryDiagnostics,
  QueryEngineClient,
  QueryErrorKind,
  type QueryFailure
} from "@wireio/ql-shared"

import { createEngineError } from "../common/errorFixtures.js"

const engineFailure = (line: number, column: number): QueryFailure =>
  QueryEngineClient.engineFailure(
    createEngineError(QueryErrorKind.QUERY_SYNTAX, { message: "Unexpected JOIN", data: { line, column } })
  )

describe("QueryDiagnostics", () => {
  it("returns nothing for valid queries, including semantically invalid ones", () => {
    expect(QueryDiagnostics.check("SELECT * FROM positions")).toEqual([])
  })

  it("reports the C++ engine's position for the JOIN query", () => {
    const [first] = QueryDiagnostics.check("SELECT * FROM sample.positions JOIN other.positions")
    expect(first).toMatchObject({ line: 1, column: 32, length: 4 })
    expect(first.message.length).toBeGreaterThan(0)
  })

  it("reports lexer errors with their span", () => {
    expect(QueryDiagnostics.check("SELECT # FROM a.b")[0]).toMatchObject({ line: 1, column: 8, length: 1 })
  })

  it("reports a missing clause at end of input", () => {
    const diagnostics = QueryDiagnostics.check("SELECT x")
    expect(diagnostics.length).toBeGreaterThan(0)
    expect(diagnostics[0].length).toBeGreaterThanOrEqual(1)
  })

  it("maps an engine failure onto the token at its position", () => {
    expect(QueryDiagnostics.fromEngineError(engineFailure(1, 32), "SELECT * FROM sample.positions JOIN other.positions")).toEqual({
      message: "Unexpected JOIN",
      line: 1,
      column: 32,
      length: 4
    })
  })

  it("defaults a positionless failure to 1:1 and an unknown position to length 1", () => {
    expect(QueryDiagnostics.fromEngineError(QueryEngineClient.cancelledFailure(), "SELECT x FROM a.b")).toMatchObject({ line: 1, column: 1, length: 6 })
    expect(QueryDiagnostics.fromEngineError(engineFailure(3, 9), "SELECT x FROM a.b")).toMatchObject({ line: 3, column: 9, length: 1 })
  })
})
