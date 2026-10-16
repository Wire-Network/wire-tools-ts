import Fs from "node:fs"
import Path from "node:path"

import { QueryDiagnostics } from "@wireio/ql-shared"

/** Expected grammar category of a corpus entry. */
enum CorpusExpectation {
  valid = "valid",
  syntaxError = "syntaxError"
}

/** One curated corpus entry (from the engine's C++ tests, README and examples). */
interface CorpusEntry {
  sql: string
  expect: CorpusExpectation
  source: string
  line?: number
  column?: number
}

const corpus: CorpusEntry[] = JSON.parse(
  Fs.readFileSync(Path.join(__dirname, "..", "fixtures", "grammar", "corpus.json"), "utf8")
)

describe("grammar corpus (antlr-ng TS parser vs the engine's WireQuery.g4 fixtures)", () => {
  it("has both categories and position-asserted entries", () => {
    expect(corpus.filter(entry => entry.expect === CorpusExpectation.valid).length).toBeGreaterThan(20)
    expect(corpus.filter(entry => entry.expect === CorpusExpectation.syntaxError).length).toBeGreaterThan(5)
    expect(corpus.some(entry => entry.line != null)).toBe(true)
  })

  it.each(corpus.map(entry => [entry.source, entry] as const))("%s", (_source, entry) => {
    const diagnostics = QueryDiagnostics.check(entry.sql)
    if (entry.expect === CorpusExpectation.valid) {
      expect(diagnostics).toEqual([])
    } else {
      expect(diagnostics.length).toBeGreaterThan(0)
      if (entry.line != null) {
        expect(diagnostics[0]).toMatchObject({ line: entry.line, column: entry.column })
      }
    }
  })
})
