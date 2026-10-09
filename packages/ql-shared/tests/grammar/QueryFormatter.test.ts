import Fs from "node:fs"
import Path from "node:path"

import {
  createQueryFormatDefaultOptions,
  KeywordCase,
  QueryDiagnostics,
  QueryFormatError,
  QueryFormatter
} from "@wireio/ql-shared"

/** A corpus entry (only the fields read here). */
interface CorpusSql {
  sql: string
  expect: string
}

const validCorpus: string[] = (
  JSON.parse(Fs.readFileSync(Path.join(__dirname, "..", "fixtures", "grammar", "corpus.json"), "utf8")) as CorpusSql[]
)
  .filter(entry => entry.expect === "valid")
  .map(entry => entry.sql)

describe("QueryFormatter", () => {
  it("puts clauses on their own lines and breaks top-level AND/OR", () => {
    expect(
      QueryFormatter.format(
        "select owner as \"Owner\",count(*) as records from \"sample.one\".positions where amount>=-10.25 and not(owner='alice' or owner is null) group by owner having count(*)>1 order by records desc limit 0;"
      )
    ).toBe(
      [
        "SELECT owner AS \"Owner\", COUNT(*) AS records",
        "FROM \"sample.one\".positions",
        "WHERE amount >= -10.25",
        "  AND NOT (owner = 'alice' OR owner IS NULL)",
        "GROUP BY owner",
        "HAVING COUNT(*) > 1",
        "ORDER BY records DESC",
        "LIMIT 0;"
      ].join("\n")
    )
  })

  it("keeps an OWNER clause, honors keyword case and indent", () => {
    expect(QueryFormatter.format("SELECT owner FROM positions OWNER 'alice', bob WHERE a = 1 OR b = 2", { keywordCase: KeywordCase.lower, indent: 4 })).toBe(
      "select owner\nfrom positions\nowner 'alice', bob\nwhere a = 1\n    or b = 2"
    )
    expect(QueryFormatter.format("Select x From a.b", { keywordCase: KeywordCase.preserve })).toBe("Select x\nFrom a.b")
    expect(createQueryFormatDefaultOptions()).toEqual({ keywordCase: KeywordCase.upper, indent: QueryFormatter.DefaultIndent })
  })

  it.each(validCorpus)("is idempotent and parse-preserving: %s", sql => {
    const once = QueryFormatter.format(sql)
    expect(QueryFormatter.format(once)).toBe(once)
    expect(QueryDiagnostics.check(once)).toEqual([])
  })

  it("throws QueryFormatError carrying the diagnostics on unparsable text", () => {
    expect(() => QueryFormatter.format("SELECT x FROM a.b JOIN c.d")).toThrow(QueryFormatError)
    try {
      QueryFormatter.format("SELECT")
    } catch (error) {
      expect((error as QueryFormatError).context.diagnostics).toBeDefined()
    }
  })
})
