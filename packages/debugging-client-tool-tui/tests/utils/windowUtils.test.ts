import { adjustStickyWindow } from "@wireio/debugging-client-tool-tui/utils/windowUtils.js"

describe("adjustStickyWindow", () => {
  /** total=20, viewport=5; cursor moves through the list. */
  it("keeps `sliceStart` parked while cursor is inside the visible range", () => {
    expect(adjustStickyWindow(5, 6, 20, 5)).toBe(5)
    expect(adjustStickyWindow(5, 9, 20, 5)).toBe(5)
  })

  it("scrolls down minimally when cursor leaves the bottom", () => {
    // window=[5..9), cursor=10 → start := 10 - 5 + 1 = 6.
    expect(adjustStickyWindow(5, 10, 20, 5)).toBe(6)
  })

  it("scrolls up minimally when cursor leaves the top", () => {
    // window=[5..9), cursor=4 → start := 4.
    expect(adjustStickyWindow(5, 4, 20, 5)).toBe(4)
  })

  it("clamps `sliceStart` to a non-negative value", () => {
    expect(adjustStickyWindow(0, 0, 20, 5)).toBe(0)
    // Cursor=0 with prevStart=10 should snap up to 0, not stay at 10.
    expect(adjustStickyWindow(10, 0, 20, 5)).toBe(0)
  })

  it("clamps `sliceStart` to maxStart when the list is shorter than expected", () => {
    // total=8, viewport=5 → maxStart=3. prev=5 → re-clamped to 3.
    expect(adjustStickyWindow(5, 7, 8, 5)).toBe(3)
  })

  it("returns 0 for an empty list", () => {
    expect(adjustStickyWindow(0, 0, 0, 5)).toBe(0)
  })

  it("returns 0 when the viewport spans the whole list", () => {
    expect(adjustStickyWindow(0, 4, 5, 5)).toBe(0)
    // Even with cursor at the end and prev mid-list, sticking inside maxStart=0
    // collapses to 0.
    expect(adjustStickyWindow(2, 4, 5, 5)).toBe(0)
  })
})
