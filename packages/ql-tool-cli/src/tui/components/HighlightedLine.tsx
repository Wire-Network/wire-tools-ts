import { Text } from "ink"

import type { HighlightToken } from "@wireio/ql-shared"

import { HighlightColors } from "../editor/index.js"

/** A run of characters sharing one style. */
export interface LineSegment {
  /** The characters. */
  text: string
  /** Ink color (undefined = default). */
  color?: string
  /** Rendered inverse (the cursor). */
  inverse: boolean
}

/** Props of {@link HighlightedLine} — every index is in CODE POINTS (the lexer's unit). */
export interface HighlightedLineProps {
  /** One line of the editor text. */
  text: string
  /** Tokens of the WHOLE text (`SyntaxHighlighter.classify`), ordered by `start`. */
  tokens: readonly HighlightToken[]
  /** Code-point offset of this line's first character in the whole text. */
  lineStart: number
  /** Cursor column (code points) on this line, or null/undefined when the cursor is elsewhere. */
  cursorColumn?: number
}

/** Placeholder cell of a cursor past the line end. */
const CursorPlaceholder = " "

/**
 * One editor line colored by the grammar's lexer (the ONE highlighter) with the
 * cursor shown inverse.
 *
 * @param props - Line, tokens, offset and cursor.
 * @returns The line element.
 */
export function HighlightedLine(props: HighlightedLineProps) {
  return (
    <Text>
      {HighlightedLine.segments(props).map((segment, index) => (
        <Text key={index} color={segment.color} inverse={segment.inverse}>
          {segment.text}
        </Text>
      ))}
    </Text>
  )
}

/** Segment math of {@link HighlightedLine}. */
export namespace HighlightedLine {
  /**
   * Split a line into styled runs in one pass over its code points (the token
   * cursor only moves forward, so a line costs O(characters + tokens)).
   *
   * @param props - Line, tokens, offset and cursor.
   * @returns The runs in order (a cursor past the end adds a placeholder run).
   */
  export function segments({ text, tokens, lineStart, cursorColumn }: HighlightedLineProps): LineSegment[] {
    const characters = Array.from(text),
      runs: LineSegment[] = []
    let tokenIndex = 0
    characters.forEach((character, column) => {
      const offset = lineStart + column
      while (tokenIndex < tokens.length && tokens[tokenIndex].stop < offset) tokenIndex += 1
      const token = tokens[tokenIndex],
        color = token != null && token.start <= offset ? HighlightColors[token.kind] : undefined,
        inverse = column === cursorColumn,
        last = runs.at(-1)
      if (last != null && last.color === color && last.inverse === inverse) {
        last.text += character
      } else {
        runs.push({ text: character, color, inverse })
      }
    })
    if (cursorColumn != null && cursorColumn >= characters.length) runs.push({ text: CursorPlaceholder, inverse: true })
    return runs
  }

  /**
   * Code points before a code-unit offset (TextBuffer cursors are code units).
   *
   * @param text - The text.
   * @param codeUnits - A UTF-16 offset into it.
   * @returns The code-point offset.
   */
  export function codePointOffset(text: string, codeUnits: number): number {
    return Array.from(text.slice(0, codeUnits)).length
  }
}
