import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import type { SavedQuery } from "@wireio/ql-shared"

import { SliceName } from "../SliceName.js"

/** Saved queries / snippets. */
export interface SavedState {
  /** Saved queries. */
  queries: SavedQuery[]
}

/**
 * The initial saved-queries state.
 *
 * @returns None saved.
 */
export function createSavedInitialState(): SavedState {
  return { queries: [] }
}

/** Saved-queries slice. */
export const SavedSlice = createSlice({
  name: SliceName.saved,
  initialState: createSavedInitialState(),
  reducers: {
    /** List (re)loaded. */
    savedLoaded(state, action: PayloadAction<SavedQuery[]>) {
      state.queries = action.payload
    }
  }
})

/** Saved-queries actions. */
export const SavedActions = SavedSlice.actions
