import { useState } from "react"
import { match } from "ts-pattern"

import { TextBuffer, type TextBufferState } from "../editor/index.js"
import { KeyScope } from "../keys/index.js"
import { useTuiKeys, type TuiKeyEvent } from "./useTuiKeys.js"

/** What a line input does with its keys. */
export interface LineInputOptions {
  /** Enter: the text. */
  onSubmit(text: string): void
  /** Esc. */
  onCancel(): void
  /**
   * A press that is neither Enter nor Esc, offered before text editing (a modal's
   * own keys — Tab, Ctrl+T); return true when it consumed the press.
   */
  onKey?(event: TuiKeyEvent): boolean
  /** Whether the input listens (default true). */
  isActive?: boolean
}

/** A live line input. */
export interface LineInput {
  /** The buffer. */
  buffer: TextBufferState
  /** Replace the text (an undo point; cursor at the end). */
  replace(text: string): void
}

/**
 * One-line text entry for modals: Enter submits, Esc cancels, other keys go to
 * `onKey` first, then edit the buffer (arrows, Home/End, Backspace, Ctrl+Z, paste).
 *
 * @param initial - Initial text.
 * @param options - Submit / cancel / extra keys.
 * @returns The buffer and a replacer.
 */
export function useLineInput(initial: string, options: LineInputOptions): LineInput {
  const [buffer, setBuffer] = useState(() => TextBuffer.create(initial))
  useTuiKeys(
    KeyScope.editor,
    event =>
      match(event)
        .with({ key: { escape: true } }, () => options.onCancel())
        .with({ key: { return: true } }, () => options.onSubmit(buffer.text))
        .otherwise(({ input, key }) => {
          if (options.onKey?.(event) !== true) setBuffer(current => TextBuffer.applyKey(current, input, key, false))
        }),
    options.isActive
  )
  return { buffer, replace: text => setBuffer(current => TextBuffer.replace(current, text)) }
}
