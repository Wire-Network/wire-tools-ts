import { HighlightTokenKind } from "@wireio/ql-shared"

import { HighlightColors } from "@wireio/ql-tool-cli/tui/index.js"

describe("HighlightColors", () => {
  it("covers every highlight token kind", () => {
    expect(Object.keys(HighlightColors).sort()).toEqual(Object.values(HighlightTokenKind).sort())
  })

  it("marks errors red", () => {
    expect(HighlightColors[HighlightTokenKind.error]).toBe("red")
  })
})
