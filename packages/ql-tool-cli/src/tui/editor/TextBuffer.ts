import type { Key } from "ink"
import { match } from "ts-pattern"

import { clampIndex } from "../../utils/index.js"

/** One undo point. */
export interface TextBufferSnapshot {
  /** Text at that point. */
  text: string
  /** Cursor offset at that point. */
  cursor: number
}

/** Immutable editor buffer (plain data — stored in the Redux editor slice). */
export interface TextBufferState extends TextBufferSnapshot {
  /** Undo points, oldest first (bounded by {@link TextBuffer.MaxUndo}). */
  undo: TextBufferSnapshot[]
}

/** A 0-based line / column position. */
export interface TextPosition {
  /** 0-based line. */
  line: number
  /** 0-based column (code units). */
  column: number
}

/** Cursor movements. */
export enum CursorMove {
  left = "left",
  right = "right",
  up = "up",
  down = "down",
  lineStart = "lineStart",
  lineEnd = "lineEnd",
  documentStart = "documentStart",
  documentEnd = "documentEnd"
}

/** Line separator of the buffer. */
const LineSeparator = "\n"

/** Pure operations over a {@link TextBufferState}; every edit returns a new state. */
export namespace TextBuffer {
  /** Undo points kept. */
  export const MaxUndo = 200
  /** Ctrl+<this> undoes (the Help route labels it via `KeyBindings.UndoChord`). */
  export const UndoInput = "z"

  /**
   * A buffer holding `text` with the cursor at its end.
   *
   * @param text - Initial text.
   * @returns The buffer.
   */
  export function create(text = ""): TextBufferState {
    return { text, cursor: text.length, undo: [] }
  }

  /**
   * Insert `inserted` at the cursor (the cursor ends after it).
   *
   * @param state - The buffer.
   * @param inserted - Text to insert (may contain line breaks).
   * @returns The new buffer.
   */
  export function insert(state: TextBufferState, inserted: string): TextBufferState {
    if (inserted.length === 0) return state
    return edit(state, `${state.text.slice(0, state.cursor)}${inserted}${state.text.slice(state.cursor)}`, state.cursor + inserted.length)
  }

  /**
   * Delete the character before the cursor (no-op at the start).
   *
   * @param state - The buffer.
   * @returns The new buffer.
   */
  export function backspace(state: TextBufferState): TextBufferState {
    if (state.cursor === 0) return state
    return edit(state, `${state.text.slice(0, state.cursor - 1)}${state.text.slice(state.cursor)}`, state.cursor - 1)
  }

  /**
   * Delete the character after the cursor (no-op at the end).
   *
   * @param state - The buffer.
   * @returns The new buffer.
   */
  export function deleteForward(state: TextBufferState): TextBufferState {
    if (state.cursor >= state.text.length) return state
    return edit(state, `${state.text.slice(0, state.cursor)}${state.text.slice(state.cursor + 1)}`, state.cursor)
  }

  /**
   * Replace the whole text (an undo point; the cursor goes to the end).
   *
   * @param state - The buffer.
   * @param text - The new text.
   * @returns The new buffer.
   */
  export function replace(state: TextBufferState, text: string): TextBufferState {
    return text === state.text ? state : edit(state, text, text.length)
  }

  /**
   * Move the cursor (never an undo point).
   *
   * @param state - The buffer.
   * @param direction - The movement.
   * @returns The new buffer.
   */
  export function move(state: TextBufferState, direction: CursorMove): TextBufferState {
    const { line, column } = position(state),
      lines = state.text.split(LineSeparator),
      cursor = match(direction)
        .with(CursorMove.left, () => Math.max(0, state.cursor - 1))
        .with(CursorMove.right, () => Math.min(state.text.length, state.cursor + 1))
        .with(CursorMove.up, () => (line === 0 ? 0 : offsetOf(state.text, { line: line - 1, column })))
        .with(CursorMove.down, () => (line === lines.length - 1 ? state.text.length : offsetOf(state.text, { line: line + 1, column })))
        .with(CursorMove.lineStart, () => offsetOf(state.text, { line, column: 0 }))
        .with(CursorMove.lineEnd, () => offsetOf(state.text, { line, column: lines[line].length }))
        .with(CursorMove.documentStart, () => 0)
        .with(CursorMove.documentEnd, () => state.text.length)
        .exhaustive()
    return cursor === state.cursor ? state : { ...state, cursor }
  }

  /**
   * Restore the latest undo point (no-op when there is none).
   *
   * @param state - The buffer.
   * @returns The new buffer.
   */
  export function undo(state: TextBufferState): TextBufferState {
    const previous = state.undo.at(-1)
    return previous == null ? state : { ...previous, undo: state.undo.slice(0, -1) }
  }

  /**
   * The cursor's 0-based line / column.
   *
   * @param state - The buffer.
   * @returns The position.
   */
  export function position(state: TextBufferState): TextPosition {
    const before = state.text.slice(0, state.cursor).split(LineSeparator)
    return { line: before.length - 1, column: before.at(-1).length }
  }

  /**
   * The buffer's lines.
   *
   * @param state - The buffer.
   * @returns The lines (at least one).
   */
  export function lines(state: TextBufferState): string[] {
    return state.text.split(LineSeparator)
  }

  /**
   * Offset of a position, the column clamped to its line.
   *
   * @param text - The text.
   * @param target - The position.
   * @returns The offset.
   */
  export function offsetOf(text: string, target: TextPosition): number {
    const lines = text.split(LineSeparator),
      line = clampIndex(target.line, lines.length)
    return (
      lines.slice(0, line).reduce((sum, current) => sum + current.length + LineSeparator.length, 0) +
      clampIndex(target.column, lines[line].length + 1)
    )
  }

  /**
   * Apply one Ink keypress to the buffer: printable input (incl. pastes) is
   * inserted, Return inserts a line break when `multiline`, Backspace/Delete
   * delete backwards (terminals report Backspace as either), arrows / Home /
   * End move, Ctrl+Z undoes. Anything else leaves the buffer unchanged.
   *
   * @param state - The buffer.
   * @param input - Ink `input`.
   * @param key - Ink `Key`.
   * @param multiline - Whether Return inserts a line break.
   * @returns The new buffer.
   */
  export function applyKey(state: TextBufferState, input: string, key: Key, multiline: boolean): TextBufferState {
    return match(key)
      .when(pressed => pressed.return, () => (multiline ? insert(state, LineSeparator) : state))
      .when(pressed => pressed.backspace || pressed.delete, () => backspace(state))
      .when(pressed => pressed.leftArrow, () => move(state, CursorMove.left))
      .when(pressed => pressed.rightArrow, () => move(state, CursorMove.right))
      .when(pressed => pressed.upArrow, () => move(state, CursorMove.up))
      .when(pressed => pressed.downArrow, () => move(state, CursorMove.down))
      .when(pressed => pressed.home, () => move(state, CursorMove.lineStart))
      .when(pressed => pressed.end, () => move(state, CursorMove.lineEnd))
      .when(pressed => pressed.ctrl && input.toLowerCase() === UndoInput, () => undo(state))
      .when(
        pressed => input.length > 0 && !pressed.ctrl && !pressed.meta && !pressed.escape && !pressed.tab,
        () => insert(state, input)
      )
      .otherwise(() => state)
  }

  /** An edit: new text + cursor, pushing the current state as an undo point. */
  function edit(state: TextBufferState, text: string, cursor: number): TextBufferState {
    return {
      text,
      cursor,
      undo: [...state.undo, { text: state.text, cursor: state.cursor }].slice(-MaxUndo)
    }
  }
}
