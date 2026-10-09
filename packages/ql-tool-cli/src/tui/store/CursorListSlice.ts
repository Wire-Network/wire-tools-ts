import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import { clampIndex, moveCursor } from "../../utils/index.js"
import type { SliceName } from "./SliceName.js"

/** A list route's state: the items and the cursor over them. */
export interface CursorListState<T> {
  /** The items, in display order. */
  items: T[]
  /** Cursor index (clamped to the items). */
  cursor: number
}

/**
 * A slice holding one cursor list (History, Saved): `itemsLoaded` replaces the
 * items and clamps the cursor, `cursorMoved` moves it.
 *
 * @param name - The slice name.
 * @returns The slice.
 */
export function createCursorListSlice<T, N extends SliceName>(name: N) {
  const initialState: CursorListState<T> = { items: [], cursor: 0 }
  return createSlice({
    name,
    initialState,
    reducers: {
      /** Items (re)loaded; the cursor is clamped. */
      itemsLoaded: (state, action: PayloadAction<T[]>): CursorListState<T> => ({
        items: action.payload,
        cursor: clampIndex(state.cursor, action.payload.length)
      }),
      /** Move the cursor by `delta` (clamped). */
      cursorMoved(state, action: PayloadAction<number>) {
        state.cursor = moveCursor(state.cursor, action.payload, state.items.length)
      }
    }
  })
}
