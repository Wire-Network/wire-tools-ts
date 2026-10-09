import { WireQueryTokens } from "@wireio/ql-shared/grammar/WireQueryTokens"

describe("WireQueryTokens", () => {
  it("derives the keyword words from the grammar", () => {
    expect(WireQueryTokens.keywordWords()).toEqual(expect.arrayContaining(["SELECT", "OWNER", "COUNT", "NULL", "DESC"]))
    expect(WireQueryTokens.keywordWords()).not.toContain("(")
  })

  it("wordOf strips the literal-name quotes", () => {
    const [select] = WireQueryTokens.lex("SELECT").tokens
    expect(WireQueryTokens.wordOf(select.type)).toBe("SELECT")
    expect([...WireQueryTokens.Aggregates].map(WireQueryTokens.wordOf)).toEqual(expect.arrayContaining(["COUNT", "SUM"]))
  })

  it("lexes without whitespace and collects lexer errors", () => {
    const lexed = WireQueryTokens.lex("SELECT  #x")
    expect(lexed.tokens.map(token => token.text)).toEqual(["SELECT", "x"])
    expect(lexed.errors).toEqual([expect.objectContaining({ start: 8, stop: 8, line: 1, column: 9 })])
  })

  it("parses with diagnostics and tokens", () => {
    const parsed = WireQueryTokens.parse("SELECT x FROM a.b")
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.tokens).toHaveLength(6)
    expect(WireQueryTokens.parse("SELECT FROM").diagnostics.length).toBeGreaterThan(0)
  })

  it("classifies clause keywords separately from modifiers", () => {
    expect(WireQueryTokens.ClauseKeywords.size).toBe(8)
    expect(WireQueryTokens.WordTokens.size).toBe(
      WireQueryTokens.Keywords.size + WireQueryTokens.Aggregates.size + WireQueryTokens.Literals.size
    )
  })
})
