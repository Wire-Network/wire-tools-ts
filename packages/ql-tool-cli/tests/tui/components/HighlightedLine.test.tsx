import { HighlightTokenKind, SyntaxHighlighter } from "@wireio/ql-shared"

import { createTuiStore, HighlightColors, HighlightedLine } from "@wireio/ql-tool-cli/tui/index.js"

import { renderTui, textOf, textsWithProp } from "../../common/renderTui.js"

describe("HighlightedLine", () => {
  const text = "SELECT 'x' FROM a.b",
    tokens = SyntaxHighlighter.classify(text)

  it("colors runs by token kind and inverts the cursor cell", () => {
    const segments = HighlightedLine.segments({ text, tokens, lineStart: 0, cursorColumn: 0 })
    expect(segments[0]).toEqual({ text: "S", color: HighlightColors[HighlightTokenKind.keyword], inverse: true })
    expect(segments[1]).toEqual({ text: "ELECT", color: HighlightColors[HighlightTokenKind.keyword], inverse: false })
    expect(segments.find(segment => segment.text === "'x'").color).toBe(HighlightColors[HighlightTokenKind.string])
    expect(segments.map(segment => segment.text).join("")).toBe(text)
  })

  it("adds a placeholder cursor past the end; no cursor, no inverse", () => {
    expect(HighlightedLine.segments({ text: "ab", tokens: [], lineStart: 0, cursorColumn: 2 }).at(-1)).toEqual({ text: " ", inverse: true })
    expect(HighlightedLine.segments({ text: "", tokens: [], lineStart: 0, cursorColumn: 0 })).toEqual([{ text: " ", inverse: true }])
    expect(HighlightedLine.segments({ text: "ab", tokens: [], lineStart: 0 })).toEqual([{ text: "ab", color: undefined, inverse: false }])
  })

  it("renders the segments", () => {
    const renderer = renderTui(<HighlightedLine text={text} tokens={tokens} lineStart={0} cursorColumn={3} />, { store: createTuiStore() })
    expect(textOf(renderer)).toBe(text)
    expect(textsWithProp(renderer, "inverse").map(instance => instance.props.children)).toEqual(["E"])
  })

  it("indexes by code point (non-BMP characters), matching the lexer", () => {
    const emoji = "SELECT '😀😀' x",
      segments = HighlightedLine.segments({ text: emoji, tokens: SyntaxHighlighter.classify(emoji), lineStart: 0, cursorColumn: 9 })
    expect(segments.map(segment => segment.text).join("")).toBe(emoji)
    expect(segments.find(segment => segment.inverse).text).toBe("😀")
    expect(segments.find(segment => segment.text.includes("😀") && !segment.inverse).color).toBe(HighlightColors[HighlightTokenKind.string])
  })

  it("codePointOffset converts a UTF-16 cursor to code points", () => {
    expect(HighlightedLine.codePointOffset("a😀b", 3)).toBe(2)
    expect(HighlightedLine.codePointOffset("abc", 0)).toBe(0)
    expect(HighlightedLine.codePointOffset("ab", 9)).toBe(2)
  })
})
