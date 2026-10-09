import { HighlightTokenKind, SyntaxHighlighter } from "@wireio/ql-shared"

const kinds = (text: string) => SyntaxHighlighter.classify(text).map(token => [text.slice(token.start, token.stop + 1), token.kind])

describe("SyntaxHighlighter", () => {
  it("classifies every token class with the generated lexer", () => {
    expect(kinds("select COUNT(*) AS n, \"limit\" FROM a.b WHERE x >= -1.5 AND y = 'it''s' OR z IS NULL;")).toEqual([
      ["select", HighlightTokenKind.keyword],
      ["COUNT", HighlightTokenKind.aggregate],
      ["(", HighlightTokenKind.punctuation],
      ["*", HighlightTokenKind.operator],
      [")", HighlightTokenKind.punctuation],
      ["AS", HighlightTokenKind.keyword],
      ["n", HighlightTokenKind.identifier],
      [",", HighlightTokenKind.punctuation],
      ["\"limit\"", HighlightTokenKind.quotedIdentifier],
      ["FROM", HighlightTokenKind.keyword],
      ["a", HighlightTokenKind.identifier],
      [".", HighlightTokenKind.punctuation],
      ["b", HighlightTokenKind.identifier],
      ["WHERE", HighlightTokenKind.keyword],
      ["x", HighlightTokenKind.identifier],
      [">=", HighlightTokenKind.operator],
      ["-", HighlightTokenKind.operator],
      ["1.5", HighlightTokenKind.number],
      ["AND", HighlightTokenKind.keyword],
      ["y", HighlightTokenKind.identifier],
      ["=", HighlightTokenKind.operator],
      ["'it''s'", HighlightTokenKind.string],
      ["OR", HighlightTokenKind.keyword],
      ["z", HighlightTokenKind.identifier],
      ["IS", HighlightTokenKind.keyword],
      ["NULL", HighlightTokenKind.literal],
      [";", HighlightTokenKind.punctuation]
    ])
  })

  it("reports 1-based positions across lines", () => {
    const tokens = SyntaxHighlighter.classify("SELECT x\nFROM a.b")
    expect(tokens[2]).toMatchObject({ line: 2, column: 1, kind: HighlightTokenKind.keyword })
  })

  it("marks an unterminated string as an error token", () => {
    const tokens = SyntaxHighlighter.classify("SELECT x FROM a.b WHERE y = 'abc")
    expect(tokens.some(token => token.kind === HighlightTokenKind.error)).toBe(true)
    expect(tokens.find(token => token.kind === HighlightTokenKind.error).start).toBe(28)
  })

  it("marks stray characters as error tokens", () => {
    expect(kinds("SELECT # FROM a.b")).toContainEqual(["#", HighlightTokenKind.error])
  })
})
