import type { SavedQuery } from "@wireio/ql-shared"

import { createCursorListSlice, type CursorListSlice, type CursorListState } from "../CursorListSlice.js"
import { SliceName } from "../SliceName.js"

/** The Saved-queries route's entries (saved order) and cursor. */
export type SavedState = CursorListState<SavedQuery>

/** Saved-queries slice. */
export const SavedSlice: CursorListSlice<SavedQuery, SliceName.saved> = createCursorListSlice<SavedQuery, SliceName.saved>(SliceName.saved)

/** The initial saved-queries state. */
export const initialSavedState: SavedState = SavedSlice.getInitialState()

/** Saved-queries actions. */
export const SavedActions: CursorListSlice<SavedQuery, SliceName.saved>["actions"] = SavedSlice.actions
