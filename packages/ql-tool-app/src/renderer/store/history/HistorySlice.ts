import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import type { QueryHistoryEntry } from "@wireio/ql-shared"

import { SliceName } from "../SliceName.js"

/** The history drawer. */
export interface HistoryState {
  /** Newest-first entries. */
  entries: QueryHistoryEntry[]
  /** Search text ("" = all). */
  search: string
}

/** History constants. */
export namespace History {
  /** Entries listed in the drawer. */
  export const ListLimit = 200
}

/**
 * The initial history state.
 *
 * @returns No entries.
 */
export function createHistoryInitialState(): HistoryState {
  return { entries: [], search: "" }
}

/** History slice. */
export const HistorySlice = createSlice({
  name: SliceName.history,
  initialState: createHistoryInitialState(),
  reducers: {
    /** Entries (re)loaded. */
    historyLoaded(state, action: PayloadAction<QueryHistoryEntry[]>) {
      state.entries = action.payload
    },
    /** Search text changed. */
    searchChanged(state, action: PayloadAction<string>) {
      state.search = action.payload
    }
  }
})

/** History actions. */
export const HistoryActions = HistorySlice.actions
