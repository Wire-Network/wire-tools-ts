import { createCursorListSlice, SliceName } from "@wireio/ql-tool-cli/tui/index.js"

describe("createCursorListSlice", () => {
  const slice = createCursorListSlice<string, SliceName.saved>(SliceName.saved)

  it("starts empty and replaces the items, clamping the cursor", () => {
    const empty = slice.getInitialState(),
      loaded = slice.reducer(empty, slice.actions.itemsLoaded(["a", "b", "c"])),
      moved = slice.reducer(loaded, slice.actions.cursorMoved(2))
    expect(empty).toEqual({ items: [], cursor: 0 })
    expect(moved).toEqual({ items: ["a", "b", "c"], cursor: 2 })
    expect(slice.reducer(moved, slice.actions.itemsLoaded(["x"]))).toEqual({ items: ["x"], cursor: 0 })
    expect(slice.reducer(moved, slice.actions.cursorMoved(-9)).cursor).toBe(0)
  })

  it("names the slice", () => {
    expect(slice.name).toBe(SliceName.saved)
  })
})
