import { useMemo } from "react"
import { Box, Text } from "ink"

import {
  CellAlignment,
  CellFormatter,
  DisplayWidth,
  ResultSearch,
  type QueryColumn,
  type QueryRow,
  type ResultView
} from "@wireio/ql-shared"

import { clampIndex } from "../../utils/index.js"

import { WindowedList } from "../components/index.js"
import { TuiColorRole, TuiPalette } from "../editor/index.js"
import { KeyBindings, TuiAction } from "../keys/index.js"
import { selectResultView, useAppSelector } from "../store/index.js"

/** Props of {@link ResultsGridPanel}. */
export interface ResultsGridPanelProps {
  /** Focused (cursor shown). */
  focused: boolean
  /** Visible data rows. */
  height: number
  /** Available width (columns). */
  width: number
}

/** The columns that fit, `[start, end)`. */
export interface ColumnWindow {
  /** First visible column index. */
  start: number
  /** One past the last visible column index. */
  end: number
}

/** Ellipsis of a truncated cell. */
const Ellipsis = "…"

/**
 * The results grid over the loaded server page: a {@link WindowedList} of the
 * client view (sorted / filtered over THIS page), horizontally scrolled to keep
 * the cursor column visible, find hits highlighted.
 *
 * @param props - Focus and size.
 * @returns The grid element.
 */
export function ResultsGridPanel({ focused, height, width }: ResultsGridPanelProps) {
  const results = useAppSelector(state => state.results),
    view = useAppSelector(state => selectResultView(state.results)),
    hits = useMemo(
      () => new Set(view == null ? [] : ResultSearch.find(view, results.findText).map(hit => `${hit.rowIndex}/${hit.column}`)),
      [view, results.findText]
    )
  if (view == null) return <Text dimColor>{ResultsGridPanel.EmptyText}</Text>
  const offset = WindowedList.offsetFor(results.cursorRow, height, view.rowCount),
    widths = ResultsGridPanel.columnWidths(view, offset, height),
    window = ResultsGridPanel.visibleColumns(widths, results.cursorColumn, width),
    columns = view.columns.slice(window.start, window.end),
    columnWidth = (index: number) => widths[window.start + index]
  return (
    <Box flexDirection="column">
      <Text bold>
        {columns
          .map((column, index) => ResultsGridPanel.fit(column.name, columnWidth(index), CellAlignment.left))
          .join(ResultsGridPanel.CellGap)}
      </Text>
      <WindowedList
        view={view}
        offset={offset}
        height={height}
        renderRow={(row: QueryRow, rowIndex: number) => (
          <Text inverse={focused && rowIndex === results.cursorRow}>
            {columns.map((column, index) => (
              <Text
                key={column.name}
                underline={focused && rowIndex === results.cursorRow && window.start + index === results.cursorColumn}
                color={hits.has(`${rowIndex}/${column.name}`) ? TuiPalette[TuiColorRole.findHit] : undefined}
                dimColor={row[column.name] === null}
              >
                {`${ResultsGridPanel.cellText(column, row, columnWidth(index))}${index < columns.length - 1 ? ResultsGridPanel.CellGap : ""}`}
              </Text>
            ))}
          </Text>
        )}
      />
    </Box>
  )
}

/** Grid layout math (pure). */
export namespace ResultsGridPanel {
  /** Widest cell (display columns). */
  export const MaxCellWidth = 32
  /** Separator between cells. */
  export const CellGap = " │ "
  /** Shown before the first successful run. */
  export const EmptyText = `no results yet — ${KeyBindings.labelOf(TuiAction.run)} runs the query`

  /**
   * Column widths over the header and the visible rows (capped at {@link MaxCellWidth}).
   *
   * @param view - The view.
   * @param offset - First visible row.
   * @param height - Visible rows.
   * @returns One width per view column.
   */
  export function columnWidths(view: ResultView, offset: number, height: number): number[] {
    const rows = view.rows({ start: offset, end: offset + height })
    return view.columns.map(column =>
      Math.min(
        MaxCellWidth,
        Math.max(
          DisplayWidth.of(column.name),
          ...rows.map(row => DisplayWidth.of(CellFormatter.format(column, row[column.name])))
        )
      )
    )
  }

  /**
   * The widest run of columns ending at (or after) the cursor column that fits `width`.
   *
   * @param widths - Column widths.
   * @param cursorColumn - Cursor column index.
   * @param width - Available width.
   * @returns The visible column window (at least the cursor column).
   */
  export function visibleColumns(widths: number[], cursorColumn: number, width: number): ColumnWindow {
    const cursor = clampIndex(cursorColumn, widths.length),
      span = (start: number, end: number) =>
        widths.slice(start, end).reduce((sum, columnWidth) => sum + columnWidth, 0) + Math.max(0, end - start - 1) * CellGap.length,
      start = [...Array(cursor + 1).keys()].find(candidate => span(candidate, cursor + 1) <= width) ?? cursor,
      end = [...Array(widths.length - cursor).keys()]
        .map(extra => cursor + 1 + extra)
        .filter(candidate => span(start, candidate) <= width)
        .at(-1) ?? cursor + 1
    return { start, end }
  }

  /**
   * Fit text into `width` display columns (truncated with an ellipsis, padded by alignment).
   *
   * @param text - Cell text.
   * @param width - Target width.
   * @param alignment - Padding side.
   * @returns The fitted text.
   */
  export function fit(text: string, width: number, alignment: CellAlignment): string {
    const fitted = DisplayWidth.of(text) <= width ? text : `${truncateTo(text, width - DisplayWidth.of(Ellipsis))}${Ellipsis}`,
      padding = " ".repeat(Math.max(0, width - DisplayWidth.of(fitted)))
    return alignment === CellAlignment.right ? `${padding}${fitted}` : `${fitted}${padding}`
  }

  /**
   * One cell's fitted text.
   *
   * @param column - The column.
   * @param row - The row.
   * @param width - Column width.
   * @returns The fitted text.
   */
  export function cellText(column: QueryColumn, row: QueryRow, width: number): string {
    return fit(CellFormatter.format(column, row[column.name]), width, CellFormatter.alignment(column))
  }
}

/** The longest prefix of `text` within `width` display columns (one pass over its code points). */
function truncateTo(text: string, width: number): string {
  const kept: string[] = []
  Array.from(text).reduce((used, character) => {
    const next = used + DisplayWidth.of(character)
    if (next > width) return Number.POSITIVE_INFINITY
    kept.push(character)
    return next
  }, 0)
  return kept.join("")
}
