import type { TextBufferState } from "../editor/index.js"
import { HighlightedLine } from "./HighlightedLine.js"

/** Props of {@link TextInputLine}. */
export interface TextInputLineProps {
  /** The edited buffer. */
  buffer: TextBufferState
  /** Whether the cursor is shown (default true). */
  focused?: boolean
}

/** A single-line input has no syntax tokens. */
const NoTokens: readonly [] = []

/**
 * One editable text line (prompt text, file name, a profile field) with the
 * cursor shown inverse.
 *
 * @param props - Buffer and focus.
 * @returns The line element.
 */
export function TextInputLine({ buffer, focused = true }: TextInputLineProps) {
  return (
    <HighlightedLine
      text={buffer.text}
      tokens={NoTokens}
      lineStart={0}
      cursorColumn={focused ? HighlightedLine.codePointOffset(buffer.text, buffer.cursor) : undefined}
    />
  )
}
