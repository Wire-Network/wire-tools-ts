import { createSlice, type PayloadAction } from "@reduxjs/toolkit"
import type { Key } from "ink"

import { TextBuffer, type CursorMove, type TextBufferState } from "../../editor/index.js"
import { SliceName } from "../SliceName.js"

/** The SQL editor buffer. */
export interface EditorState {
  /** The buffer (text, cursor, undo points). */
  buffer: TextBufferState
}

/** One raw keypress for the editor. */
export interface EditorKeyPress {
  /** Ink `input`. */
  input: string
  /** Ink `Key`. */
  key: Key
}

/** The initial (empty) editor. */
export const initialEditorState: EditorState = { buffer: TextBuffer.create() }

/** Editor slice — every reducer delegates to the pure {@link TextBuffer}. */
export const EditorSlice = createSlice({
  name: SliceName.editor,
  initialState: initialEditorState,
  reducers: {
    /** Replace the text (an undo point). */
    textReplaced(state, action: PayloadAction<string>) {
      state.buffer = TextBuffer.replace(state.buffer, action.payload)
    },
    /** Insert at the cursor. */
    textInserted(state, action: PayloadAction<string>) {
      state.buffer = TextBuffer.insert(state.buffer, action.payload)
    },
    /** Delete before the cursor. */
    backspaced(state) {
      state.buffer = TextBuffer.backspace(state.buffer)
    },
    /** Delete after the cursor. */
    deletedForward(state) {
      state.buffer = TextBuffer.deleteForward(state.buffer)
    },
    /** Move the cursor. */
    cursorMoved(state, action: PayloadAction<CursorMove>) {
      state.buffer = TextBuffer.move(state.buffer, action.payload)
    },
    /** Apply a raw keypress (text entry, deletion, movement, undo — multi-line). */
    keyApplied(state, action: PayloadAction<EditorKeyPress>) {
      state.buffer = TextBuffer.applyKey(state.buffer, action.payload.input, action.payload.key, true)
    },
    /** Undo the last edit. */
    undone(state) {
      state.buffer = TextBuffer.undo(state.buffer)
    }
  }
})

/** Editor actions. */
export const EditorActions = EditorSlice.actions
