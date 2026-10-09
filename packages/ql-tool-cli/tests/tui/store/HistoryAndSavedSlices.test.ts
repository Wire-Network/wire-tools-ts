import { QueryOutcome } from "@wireio/ql-shared"

import { HistoryActions, HistorySlice, initialHistoryState, initialSavedState, SavedActions, SavedSlice } from "@wireio/ql-tool-cli/tui/index.js"

const entry = { id: "1", profile: "p", query: "q", executedAt: new Date().toISOString(), outcome: QueryOutcome.success, errorKind: null, returnedRows: 1, wallTimeMs: 1 }
const saved = { id: "s", name: "n", query: "q", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }

describe("HistorySlice", () => {
  it("loads entries and moves the cursor (clamped)", () => {
    const loaded = HistorySlice.reducer(initialHistoryState, HistoryActions.itemsLoaded([entry, { ...entry, id: "2" }]))
    expect(HistorySlice.reducer(loaded, HistoryActions.cursorMoved(1)).cursor).toBe(1)
    expect(HistorySlice.reducer(loaded, HistoryActions.cursorMoved(-5)).cursor).toBe(0)
    expect(HistorySlice.reducer({ ...loaded, cursor: 1 }, HistoryActions.itemsLoaded([])).cursor).toBe(0)
  })
})

describe("SavedSlice", () => {
  it("loads queries and moves the cursor (clamped)", () => {
    const loaded = SavedSlice.reducer(initialSavedState, SavedActions.itemsLoaded([saved, { ...saved, id: "t" }]))
    expect(SavedSlice.reducer(loaded, SavedActions.cursorMoved(9)).cursor).toBe(1)
    expect(SavedSlice.reducer({ ...loaded, cursor: 1 }, SavedActions.itemsLoaded([saved])).cursor).toBe(0)
  })
})
