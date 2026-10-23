import { createSlice, type CaseReducers, type Draft, type PayloadAction, type Slice } from "@reduxjs/toolkit"

import { clampIndex, moveCursor } from "../../utils/index.js"
import type { SliceName } from "./SliceName.js"

/** A list route's state: the items and the cursor over them. */
export interface CursorListState<T> {
  /** The items, in display order. */
  items: T[]
  /** Cursor index (clamped to the items). */
  cursor: number
}

/** The action of each cursor-list case reducer, keyed by case-reducer name. */
export interface CursorListActions<T> {
  /** `itemsLoaded`: the new items, in display order. */
  itemsLoaded: PayloadAction<T[]>
  /** `cursorMoved`: the signed cursor delta. */
  cursorMoved: PayloadAction<number>
}

/**
 * The case reducers of a cursor-list slice — RTK's `CaseReducers` over
 * {@link CursorListActions}, so a concrete slice's declared type names `Draft`
 * generically instead of immer's resolved draft type. The `Pick` over every key
 * re-presents the interface as a mapped type: RTK's `Actions` constraint is an
 * index signature, which a mapped type satisfies and an interface does not.
 */
export type CursorListCaseReducers<T> = CaseReducers<
  CursorListState<T>,
  Pick<CursorListActions<T>, keyof CursorListActions<T>>
>

/** A cursor-list slice named `N` over items of type `T`. */
export type CursorListSlice<T, N extends SliceName> = Slice<CursorListState<T>, CursorListCaseReducers<T>, N>

/**
 * A slice holding one cursor list (History, Saved): `itemsLoaded` replaces the
 * items and clamps the cursor, `cursorMoved` moves it.
 *
 * @param name - The slice name.
 * @returns The slice.
 */
export function createCursorListSlice<T, N extends SliceName>(name: N): CursorListSlice<T, N> {
  const initialState: CursorListState<T> = { items: [], cursor: 0 }
  return createSlice({
    name,
    initialState,
    reducers: {
      /** Items (re)loaded; the cursor is clamped. */
      itemsLoaded: (state: Draft<CursorListState<T>>, action: PayloadAction<T[]>): CursorListState<T> => ({
        items: action.payload,
        cursor: clampIndex(state.cursor, action.payload.length)
      }),
      /** Move the cursor by `delta` (clamped). */
      cursorMoved(state: Draft<CursorListState<T>>, action: PayloadAction<number>) {
        state.cursor = moveCursor(state.cursor, action.payload, state.items.length)
      }
    }
  })
}
