import { createTuiStore, SliceName, TuiReducers, useAppDispatch, useAppSelector } from "@wireio/ql-tool-cli/tui/index.js"

describe("TUI store", () => {
  it("holds one slice per SliceName (identity enum)", () => {
    Object.entries(SliceName).forEach(([name, value]) => expect(value).toBe(name))
    expect(Object.keys(TuiReducers).sort()).toEqual(Object.values(SliceName).sort())
    expect(Object.keys(createTuiStore().getState()).sort()).toEqual(Object.values(SliceName).sort())
  })

  it("starts with empty/initial state", () => {
    const state = createTuiStore().getState()
    expect(state.editor.buffer.text).toBe("")
    expect(state.connection.profile).toBeNull()
    expect(state.results.execution).toBeNull()
  })

  it("exports typed hooks", () => {
    expect(typeof useAppDispatch).toBe("function")
    expect(typeof useAppSelector).toBe("function")
  })
})
