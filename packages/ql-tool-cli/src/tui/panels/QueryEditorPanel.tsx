import { useMemo } from "react"
import { Text } from "ink"

import { QueryDiagnostics, ResultSummary, SyntaxHighlighter } from "@wireio/ql-shared"

import { HighlightedLine, Panel, WindowedList } from "../components/index.js"
import { TextBuffer, TuiColorRole, TuiPalette } from "../editor/index.js"
import { KeyBindings, TuiAction } from "../keys/index.js"
import { useAppSelector } from "../store/index.js"

/** Props of {@link QueryEditorPanel}. */
export interface QueryEditorPanelProps {
  /** Focused (cursor shown, brand border). */
  focused: boolean
  /** Visible lines. */
  height: number
}

/**
 * The SQL editor: lexer-highlighted lines, the cursor, and live grammar
 * diagnostics (the engine reports semantic errors on run).
 *
 * @param props - Focus and height.
 * @returns The panel element.
 */
export function QueryEditorPanel({ focused, height }: QueryEditorPanelProps) {
  const buffer = useAppSelector(state => state.editor.buffer),
    tokens = useMemo(() => SyntaxHighlighter.classify(buffer.text), [buffer.text]),
    diagnostic = useMemo(() => QueryDiagnostics.check(buffer.text)[0], [buffer.text]),
    lines = TextBuffer.lines(buffer),
    cursor = TextBuffer.position(buffer),
    lineStarts = useMemo(() => QueryEditorPanel.lineStarts(lines), [buffer.text]),
    visible = WindowedList.window(lines, cursor.line, height)
  return (
    <Panel title={QueryEditorPanel.Title} focused={focused} height={height + QueryEditorPanel.ChromeRows}>
      {visible.items.map((line, index) => {
        const lineIndex = visible.offset + index
        return (
          <HighlightedLine
            key={lineIndex}
            text={line}
            tokens={tokens}
            lineStart={lineStarts[lineIndex]}
            cursorColumn={focused && lineIndex === cursor.line ? HighlightedLine.codePointOffset(line, cursor.column) : undefined}
          />
        )
      })}
      {diagnostic != null && buffer.text.trim().length > 0 && (
        <Text color={TuiPalette[TuiColorRole.error]} wrap="truncate">{`${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`}</Text>
      )}
    </Panel>
  )
}

/** Editor panel constants. */
export namespace QueryEditorPanel {
  /** Panel title. */
  export const Title = `Query  (${ResultSummary.join([
    `${KeyBindings.labelOf(TuiAction.run)} run`,
    `${KeyBindings.labelOf(TuiAction.format)} format`
  ])})`
  /** Rows of border, title and diagnostic line. */
  export const ChromeRows = 4
  /** Code points of the line break between editor lines. */
  export const LineBreakCodePoints = 1

  /**
   * The code-point offset of every line's first character in the whole text
   * (the lexer's unit), in one pass.
   *
   * @param lines - The editor lines.
   * @returns One offset per line.
   */
  export function lineStarts(lines: readonly string[]): number[] {
    const starts: number[] = []
    lines.reduce((offset, line) => {
      starts.push(offset)
      return offset + Array.from(line).length + LineBreakCodePoints
    }, 0)
    return starts
  }
}
