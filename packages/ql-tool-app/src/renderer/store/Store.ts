import { configureStore, type ThunkAction, type UnknownAction } from "@reduxjs/toolkit"

import type { QLBridge } from "../../common/index.js"
import type { QueryPortClient } from "../query/index.js"
import { CatalogSlice } from "./catalog/CatalogSlice.js"
import { ConnectionsSlice } from "./connections/ConnectionsSlice.js"
import { HistorySlice } from "./history/HistorySlice.js"
import { ResultsSlice } from "./results/ResultsSlice.js"
import type { RootState } from "./RootState.js"
import { SavedSlice } from "./saved/SavedSlice.js"
import { SliceName } from "./SliceName.js"
import { UiSlice } from "./ui/UiSlice.js"
import { WorkspaceSlice } from "./workspace/WorkspaceSlice.js"

/** What thunks reach outside the store (injected; tests fake them). */
export interface WorkbenchServices {
  /** The preload bridge (stores, dialogs, export, menus). */
  bridge: QLBridge
  /** The query-host port client. */
  queryPort: QueryPortClient
  /** Request-id generator. */
  createRequestId: () => string
  /** Wall clock. */
  clock: () => Date
}

/** A workbench thunk (resolves when its side effects are done). */
export type AppThunk<T = void> = ThunkAction<Promise<T>, RootState, WorkbenchServices, UnknownAction>

/**
 * Create the renderer store. The serializable/immutable dev checks are off:
 * results hold up to tens of thousands of plain JSON rows, and walking them on
 * every action would stall the UI thread (the data IS plain JSON by construction).
 *
 * @param services - Thunk services.
 * @param preloadedState - Optional initial state (tests).
 * @returns The store.
 */
export function createWorkbenchStore(services: WorkbenchServices, preloadedState?: Partial<RootState>) {
  return configureStore({
    reducer: {
      [SliceName.connections]: ConnectionsSlice.reducer,
      [SliceName.workspace]: WorkspaceSlice.reducer,
      [SliceName.results]: ResultsSlice.reducer,
      [SliceName.catalog]: CatalogSlice.reducer,
      [SliceName.history]: HistorySlice.reducer,
      [SliceName.saved]: SavedSlice.reducer,
      [SliceName.ui]: UiSlice.reducer
    },
    preloadedState,
    middleware: getDefaultMiddleware =>
      getDefaultMiddleware({
        thunk: { extraArgument: services },
        serializableCheck: false,
        immutableCheck: false
      })
  })
}

/** The renderer store. */
export type WorkbenchStore = ReturnType<typeof createWorkbenchStore>

/** The store's dispatch. */
export type AppDispatch = WorkbenchStore["dispatch"]
