import {
  compileSearchRegex,
  renderWithHighlight,
  sliceForHorizontalOffset
} from "@wireio/debugging-client-tool-tui/features/process-monitor/util/lineRender.js"

describe("sliceForHorizontalOffset", () => {
  it("returns the original string when offset is 0 or out of range", () => {
    expect(sliceForHorizontalOffset("hello", 0)).toBe("hello")
    expect(sliceForHorizontalOffset("hello", 50)).toBe("hello")
  })

  it("drops the first `offset` characters when in range", () => {
    expect(sliceForHorizontalOffset("hello world", 6)).toBe("world")
  })
})

describe("compileSearchRegex", () => {
  it("returns null for empty input", () => {
    expect(compileSearchRegex("")).toBeNull()
  })

  it("treats plain input as a case-insensitive literal substring (metachars escaped)", () => {
    const re = compileSearchRegex("foo.bar")
    expect(re).not.toBeNull()
    expect("foo.bar".match(re!)).not.toBeNull()
    // Literal mode means '.' should NOT match arbitrary chars.
    expect("fooxbar".match(re!)).toBeNull()
  })

  it("treats /pattern/ as a JS regex (case-insensitive, global)", () => {
    const re = compileSearchRegex("/foo.bar/")
    expect(re).not.toBeNull()
    expect("FOOxBAR".match(re!)).not.toBeNull()
    // The g flag is set so matchAll works without errors.
    expect(re!.flags).toContain("g")
    expect(re!.flags).toContain("i")
  })

  it("returns null for an unparseable regex pattern", () => {
    expect(compileSearchRegex("/[unclosed/")).toBeNull()
  })

  it("returns null for `//` (empty regex body)", () => {
    expect(compileSearchRegex("//")).toBeNull()
  })

  it("treats a single `/` as a literal one-character search, not regex mode", () => {
    const re = compileSearchRegex("/")
    expect(re).not.toBeNull()
    expect("a/b".match(re!)).not.toBeNull()
  })
})

describe("renderWithHighlight", () => {
  it("returns a single Text node when the term yields no matches", () => {
    const result = renderWithHighlight("hello world", "xyz")
    const serialized = JSON.stringify(result)
    // A single matchless render should not contain the inverse marker.
    expect(serialized).not.toContain('"inverse":true')
    expect(serialized).toContain("hello world")
  })

  it("wraps literal substring matches in inverse-video Text", () => {
    const serialized = JSON.stringify(
      renderWithHighlight("alpha beta alpha", "alpha")
    )
    // Two matches → two inverse hits.
    const inverseCount = serialized.match(/"inverse":true/g)?.length ?? 0
    expect(inverseCount).toBe(2)
  })

  it("highlights the actual regex match span (not the pattern length)", () => {
    // `/\d+/` is 5 chars including delimiters; the match against "abc 123 xyz"
    // must be exactly "123" (3 chars). Digits dodge the case-insensitive flag's
    // letter-broadening, so this isolates the span-from-match-result behavior.
    const serialized = JSON.stringify(
      renderWithHighlight("abc 123 xyz", "/\\d+/")
    )
    expect(serialized).toContain('"inverse":true')
    expect(serialized).toContain("123")
    // Surrounding non-digit text remains in plain (non-inverse) Text nodes.
    expect(serialized).toContain("abc ")
    expect(serialized).toContain(" xyz")
  })

  it("falls through to a plain Text node when the regex is invalid", () => {
    const serialized = JSON.stringify(renderWithHighlight("hello", "/[broken/"))
    expect(serialized).not.toContain('"inverse":true')
    expect(serialized).toContain("hello")
  })
})
