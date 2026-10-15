import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import type { PageWindow } from "@wireio/ql-shared"

import { SliceName } from "../SliceName.js"

/** Workbench dialogs and drawers (identity enum). */
export enum UiSurface {
  history = "history",
  saved = "saved",
  connections = "connections",
  export = "export",
  saveQuery = "saveQuery",
  find = "find"
}

/** A cell opened in the value inspector. */
export interface InspectorTarget {
  /** View row index. */
  rowIndex: number
  /** Column name. */
  column: string
}

/** The toolbar's explicit server window (raw text fields; "" = unset). */
export interface WindowFields {
  /** Offset text. */
  offset: string
  /** Limit text. */
  limit: string
}

/** Transient UI state. */
export interface UiState {
  /** Open surfaces. */
  open: UiSurface[]
  /** Find-in-results text. */
  findText: string
  /** Focused find hit index. */
  findHitIndex: number
  /** Value inspector target (null = closed). */
  inspector: InspectorTarget
  /** Toolbar Offset / Limit. */
  windowFields: WindowFields
  /** Grid cell cursor (null = none). */
  cursor: InspectorTarget
  /** Transient notice (null = none). */
  notice: string
}

/**
 * The initial UI state.
 *
 * @returns Everything closed.
 */
export function createUiInitialState(): UiState {
  return {
    open: [],
    findText: "",
    findHitIndex: 0,
    inspector: null,
    windowFields: { offset: "", limit: "" },
    cursor: null,
    notice: null
  }
}

/** UI slice. */
export const UiSlice = createSlice({
  name: SliceName.ui,
  initialState: createUiInitialState(),
  reducers: {
    /** Open a surface. */
    surfaceOpened(state, action: PayloadAction<UiSurface>) {
      if (!state.open.includes(action.payload)) state.open.push(action.payload)
    },
    /** Close a surface. */
    surfaceClosed(state, action: PayloadAction<UiSurface>) {
      state.open = state.open.filter(surface => surface !== action.payload)
    },
    /** Toggle a surface. */
    surfaceToggled(state, action: PayloadAction<UiSurface>) {
      state.open = state.open.includes(action.payload)
        ? state.open.filter(surface => surface !== action.payload)
        : [...state.open, action.payload]
    },
    /** Find text changed (resets the focused hit). */
    findTextChanged(state, action: PayloadAction<string>) {
      state.findText = action.payload
      state.findHitIndex = 0
    },
    /** Focus another find hit. */
    findHitSelected(state, action: PayloadAction<number>) {
      state.findHitIndex = action.payload
    },
    /** Open / close the value inspector. */
    inspectorChanged(state, action: PayloadAction<InspectorTarget>) {
      state.inspector = action.payload
    },
    /** Toolbar Offset / Limit edited. */
    windowFieldsChanged(state, action: PayloadAction<WindowFields>) {
      state.windowFields = action.payload
    },
    /** Grid cursor moved. */
    cursorMoved(state, action: PayloadAction<InspectorTarget>) {
      state.cursor = action.payload
    },
    /** Show / clear a notice. */
    noticeChanged(state, action: PayloadAction<string>) {
      state.notice = action.payload
    }
  }
})

/** UI actions. */
export const UiActions = UiSlice.actions

/** UI helpers. */
export namespace Ui {
  /**
   * The explicit window of the toolbar fields (null when neither is set).
   *
   * @param fields - The raw fields.
   * @returns `{ offset, limit }` (an unset limit is null), or null.
   */
  export function explicitWindowOf(fields: WindowFields): PageWindow {
    const offset = parseCount(fields.offset),
      limit = parseCount(fields.limit)
    return offset == null && limit == null ? null : { offset: offset ?? 0, limit }
  }

  /**
   * A non-negative integer field (blank / invalid → null).
   *
   * @param text - Field text.
   * @returns The integer, or null.
   */
  export function parseCount(text: string): number {
    const trimmed = text.trim()
    return /^\d+$/.test(trimmed) ? Number(trimmed) : null
  }
}
