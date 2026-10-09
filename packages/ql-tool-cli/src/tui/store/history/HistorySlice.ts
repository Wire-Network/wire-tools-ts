import type { QueryHistoryEntry } from "@wireio/ql-shared"

import { createCursorListSlice, type CursorListState } from "../CursorListSlice.js"
import { SliceName } from "../SliceName.js"

/** The History route's entries (newest first) and cursor. */
export type HistoryState = CursorListState<QueryHistoryEntry>

/** History slice. */
export const HistorySlice = createCursorListSlice<QueryHistoryEntry, SliceName.history>(SliceName.history)

/** The initial history state. */
export const initialHistoryState: HistoryState = HistorySlice.getInitialState()

/** History actions. */
export const HistoryActions = HistorySlice.actions
