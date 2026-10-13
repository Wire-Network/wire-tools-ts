import { clampIndex, moveCursor } from "@wireio/ql-tool-cli/utils/index.js"

describe("cursorUtils", () => {
  it("clamps into [0, count)", () => {
    expect(clampIndex(5, 3)).toBe(2)
    expect(clampIndex(-1, 3)).toBe(0)
    expect(clampIndex(1, 3)).toBe(1)
    expect(clampIndex(4, 0)).toBe(0)
  })

  it("moves by a delta, clamped", () => {
    expect(moveCursor(0, -1, 2)).toBe(0)
    expect(moveCursor(1, 1, 2)).toBe(1)
    expect(moveCursor(0, 1, 2)).toBe(1)
    expect(moveCursor(0, 1, 0)).toBe(0)
  })
})
