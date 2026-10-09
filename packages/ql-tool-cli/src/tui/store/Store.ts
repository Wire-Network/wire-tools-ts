import { configureStore } from "@reduxjs/toolkit"

import { CatalogSlice } from "./catalog/CatalogSlice.js"
import { ConnectionSlice } from "./connection/ConnectionSlice.js"
import { EditorSlice } from "./editor/EditorSlice.js"
import { HistorySlice } from "./history/HistorySlice.js"
import { ResultsSlice } from "./results/ResultsSlice.js"
import { SavedSlice } from "./saved/SavedSlice.js"
import { SliceName } from "./SliceName.js"
import { UiSlice } from "./ui/UiSlice.js"

/** The reducer map of the TUI store (one slice per domain). */
export const TuiReducers = {
  [SliceName.connection]: ConnectionSlice.reducer,
  [SliceName.editor]: EditorSlice.reducer,
  [SliceName.results]: ResultsSlice.reducer,
  [SliceName.catalog]: CatalogSlice.reducer,
  [SliceName.history]: HistorySlice.reducer,
  [SliceName.saved]: SavedSlice.reducer,
  [SliceName.ui]: UiSlice.reducer
}

/**
 * Create the TUI store. The development immutability / serializability checks
 * are off: a result page can hold 10k rows, and every payload is plain JSON by
 * construction (engine results, catalog snapshots, store documents).
 *
 * @returns The store.
 */
export function createTuiStore() {
  return configureStore({
    reducer: TuiReducers,
    middleware: getDefaultMiddleware => getDefaultMiddleware({ immutableCheck: false, serializableCheck: false })
  })
}

/** The TUI store. */
export type TuiStore = ReturnType<typeof createTuiStore>
/** The store's dispatch. */
export type TuiDispatch = TuiStore["dispatch"]
