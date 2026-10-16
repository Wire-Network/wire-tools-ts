import { QueryErrorKind, QueryFailureKind, type QueryErrorData, type QueryFailure } from "@wireio/ql-shared"

import { ErrorPrinter } from "@wireio/ql-tool-cli/cli/index.js"

import { createFailure } from "../../common/engineFixtures.js"
import { captureLogs } from "../../common/logCapture.js"

/** An engine failure (QUERY_SYNTAX at 1:31 unless overridden). */
function failure(data: Partial<QueryErrorData> = {}): QueryFailure {
  return createFailure({ message: "unexpected JOIN", data: { line: 1, column: 31, ...data } })
}

describe("ErrorPrinter.failureLines", () => {
  const query = "SELECT * FROM \"sysio.opreg\".x JOIN c.d"

  it("prints kind, message and a caret under the reported column", () => {
    const lines = ErrorPrinter.failureLines(failure(), query)
    expect(lines[0]).toBe("error: QUERY_SYNTAX: unexpected JOIN")
    expect(lines[1]).toBe(`  ${query}`)
    expect(lines[2]).toBe(`  ${" ".repeat(30)}^^^^`)
  })

  it("puts the caret at column 1 and past the end", () => {
    expect(ErrorPrinter.failureLines(failure({ column: 1 }), query)[2]).toMatch(/^ {2}\^/)
    expect(ErrorPrinter.failureLines(failure({ column: query.length + 1 }), query)[2]).toBe(`  ${" ".repeat(query.length)}^`)
  })

  it("adds the retry hint only when the server marked the failure retryable; no caret without a position", () => {
    expect(ErrorPrinter.failureLines(failure({ retryable: true, line: null, column: null, kind: QueryErrorKind.QUERY_BUSY }), query)).toEqual([
      "error: QUERY_BUSY: unexpected JOIN",
      ErrorPrinter.RetryHint
    ])
    expect(ErrorPrinter.failureLines(createFailure({ kind: QueryFailureKind.transport, message: "unexpected JOIN" }), query)).toEqual([
      "error: transport: unexpected JOIN"
    ])
  })

  it("prints failures, errors and hints on the stderr channel", () => {
    const logs = captureLogs()
    try {
      ErrorPrinter.printFailure(failure({ line: null }), query)
      ErrorPrinter.printError(new Error("bad"))
      ErrorPrinter.printHint("a hint")
      expect(logs.stderr()).toEqual(["error: QUERY_SYNTAX: unexpected JOIN", "error: bad", "a hint"])
      expect(logs.stdout()).toEqual([])
    } finally {
      logs.restore()
    }
  })
})
