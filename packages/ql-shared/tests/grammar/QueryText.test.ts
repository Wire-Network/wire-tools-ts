import { QueryText } from "@wireio/ql-shared"
import { WireQueryTokens } from "@wireio/ql-shared/grammar/WireQueryTokens"

describe("QueryText", () => {
  it("leaves plain identifiers unquoted", () => {
    expect(QueryText.qualifyTable("sample", "positions")).toBe("sample.positions")
    expect(QueryText.isPlainIdentifier("Mixed_Case1")).toBe(true)
  })

  it("quotes dotted names, keywords and odd characters", () => {
    expect(QueryText.qualifyTable("sysio.opreg", "operators")).toBe("\"sysio.opreg\".operators")
    expect(QueryText.qualifyTable("sysio.roa", "select")).toBe("\"sysio.roa\".\"select\"")
    expect(QueryText.quoteIdentifier("count")).toBe("\"count\"")
    expect(QueryText.quoteIdentifier("a\"b")).toBe("\"a\"\"b\"")
    expect(QueryText.quoteIdentifier("1abc")).toBe("\"1abc\"")
  })

  it("quotes string literals", () => {
    expect(QueryText.quoteString("it's")).toBe("'it''s'")
  })

  it("builds the describe query", () => {
    expect(QueryText.selectAllQuery("sysio.opreg", "operators")).toBe("SELECT * FROM \"sysio.opreg\".operators")
  })

  it("unquotes identifiers and strings, undoing doubled quotes (the inverse of quoting)", () => {
    expect(QueryText.unquoteIdentifier(QueryText.quoteIdentifier("a\"b.c"))).toBe("a\"b.c")
    expect(QueryText.unquoteString(QueryText.quoteString("it's"))).toBe("it's")
    expect(QueryText.unquoteString("''")).toBe("")
  })

  it("nameOf reads an identifier as written and unquotes quoted names; absent for no token", () => {
    const [plain, quoted, literal] = WireQueryTokens.lex("abc \"sysio.opreg\" 'x''y'").tokens
    expect([plain, quoted, literal].map(QueryText.nameOf)).toEqual(["abc", "sysio.opreg", "x'y"])
    expect(QueryText.nameOf(undefined)).toBeUndefined()
  })
})
