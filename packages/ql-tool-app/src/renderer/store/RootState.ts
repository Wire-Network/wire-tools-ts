import type { CatalogState } from "./catalog/CatalogSlice.js"
import type { ConnectionsState } from "./connections/ConnectionsSlice.js"
import type { HistoryState } from "./history/HistorySlice.js"
import type { ResultsState } from "./results/ResultsSlice.js"
import type { SavedState } from "./saved/SavedSlice.js"
import { SliceName } from "./SliceName.js"
import type { UiState } from "./ui/UiSlice.js"
import type { WorkspaceState } from "./workspace/WorkspaceSlice.js"

/** The whole renderer state (declared from the slices so no import cycle runs through the store). */
export interface RootState {
  [SliceName.connections]: ConnectionsState
  [SliceName.workspace]: WorkspaceState
  [SliceName.results]: ResultsState
  [SliceName.catalog]: CatalogState
  [SliceName.history]: HistoryState
  [SliceName.saved]: SavedState
  [SliceName.ui]: UiState
}
