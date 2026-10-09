import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import { SliceName } from "../SliceName.js"

/** Focusable workbench areas, in Tab order. */
export enum FocusArea {
  schema = "schema",
  editor = "editor",
  grid = "grid"
}

/** Result tabs, in display order. */
export enum ResultsTab {
  grid = "grid",
  json = "json",
  record = "record",
  fieldTypes = "fieldTypes",
  stats = "stats",
  state = "state",
  messages = "messages"
}

/** The open modal (one at a time). */
export enum TuiModal {
  none = "none",
  export = "export",
  inspector = "inspector",
  find = "find",
  columns = "columns",
  prompt = "prompt"
}

/** What a prompt asks for. */
export enum PromptKind {
  filter = "filter",
  saveQuery = "saveQuery",
  window = "window"
}

/** Severity of a message in the Messages tab. */
export enum MessageLevel {
  info = "info",
  warn = "warn",
  error = "error"
}

/** An open prompt. */
export interface PromptRequest {
  /** What it asks for. */
  kind: PromptKind
  /** Title line. */
  title: string
  /** Initial text. */
  initial: string
  /** Column a filter prompt applies to (filter only). */
  column?: string
}

/** One Messages-tab line. */
export interface TuiMessage {
  /** Severity. */
  level: MessageLevel
  /** Text. */
  text: string
  /** ISO-8601 time. */
  at: string
}

/** Layout / modal state. */
export interface UiState {
  /** Focused area. */
  focus: FocusArea
  /** Active results tab. */
  tab: ResultsTab
  /** Open modal. */
  modal: TuiModal
  /** Open prompt (when `modal` is `prompt`), else null. */
  prompt: PromptRequest
  /** Messages, oldest first (bounded by {@link UiState.MaxMessages}). */
  messages: TuiMessage[]
}

/** The initial UI state (the editor is focused). */
export const initialUiState: UiState = {
  focus: FocusArea.editor,
  tab: ResultsTab.grid,
  modal: TuiModal.none,
  prompt: null,
  messages: []
}

/** UI constants and derivations. */
export namespace UiState {
  /** Messages kept. */
  export const MaxMessages = 200

  /**
   * The area `step` positions after `focus` in Tab order (wrapping).
   *
   * @param focus - Current area.
   * @param step - +1 next, -1 previous.
   * @returns The new area.
   */
  export function cycleFocus(focus: FocusArea, step: number): FocusArea {
    const order = Object.values(FocusArea),
      index = order.indexOf(focus)
    return order[(index + step + order.length) % order.length]
  }
}

/** UI slice. */
export const UiSlice = createSlice({
  name: SliceName.ui,
  initialState: initialUiState,
  reducers: {
    /** Tab: next area. */
    focusedNext(state) {
      state.focus = UiState.cycleFocus(state.focus, 1)
    },
    /** Shift+Tab: previous area. */
    focusedPrevious(state) {
      state.focus = UiState.cycleFocus(state.focus, -1)
    },
    /** Focus an area. */
    focusSet(state, action: PayloadAction<FocusArea>) {
      state.focus = action.payload
    },
    /** Show a results tab. */
    tabSelected(state, action: PayloadAction<ResultsTab>) {
      state.tab = action.payload
    },
    /** Alt+J: grid ↔ JSON. */
    jsonToggled(state) {
      state.tab = state.tab === ResultsTab.json ? ResultsTab.grid : ResultsTab.json
    },
    /** Alt+V: grid ↔ record view. */
    recordViewToggled(state) {
      state.tab = state.tab === ResultsTab.record ? ResultsTab.grid : ResultsTab.record
    },
    /** Open a (non-prompt) modal. */
    modalOpened(state, action: PayloadAction<TuiModal>) {
      state.modal = action.payload
      state.prompt = null
    },
    /** Open a prompt. */
    promptOpened(state, action: PayloadAction<PromptRequest>) {
      state.modal = TuiModal.prompt
      state.prompt = action.payload
    },
    /** Close any modal. */
    modalClosed(state) {
      state.modal = TuiModal.none
      state.prompt = null
    },
    /**
     * Add a Messages-tab line (bounded by {@link UiState.MaxMessages}) — the ONE
     * way every route, modal and service reports: `UiActions.message(level, text)`
     * stamps the time.
     */
    message: {
      reducer(state, action: PayloadAction<TuiMessage>) {
        state.messages = [...state.messages, action.payload].slice(-UiState.MaxMessages)
      },
      prepare(level: MessageLevel, text: string) {
        return { payload: { level, text, at: new Date().toISOString() } }
      }
    }
  }
})

/** UI actions. */
export const UiActions = UiSlice.actions
