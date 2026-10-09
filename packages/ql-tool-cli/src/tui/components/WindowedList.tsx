import type { ReactNode } from "react"
import { Box, Text } from "ink"

import type { QueryRow, ResultView } from "@wireio/ql-shared"

import { clampIndex } from "../../utils/index.js"

/** Props of {@link WindowedList}. */
export interface WindowedListProps {
  /** The view whose rows are listed. */
  view: ResultView
  /** First visible view index (clamped). */
  offset: number
  /** Visible rows. */
  height: number
  /** Render one row (`index` is the view index). */
  renderRow: (row: QueryRow, index: number) => ReactNode
  /** Shown when the view has no rows. */
  emptyText?: string
}

/**
 * Renders exactly rows `[offset, offset + height)` of a {@link ResultView} —
 * the window math is explicit (no Ink measuring), so a 10k-row page costs
 * `height` row renders.
 *
 * @param props - View, window and row renderer.
 * @returns The list element.
 */
export function WindowedList({ view, offset, height, renderRow, emptyText = WindowedList.DefaultEmptyText }: WindowedListProps) {
  if (view.rowCount === 0) return <Text dimColor>{emptyText}</Text>
  const start = WindowedList.clampOffset(offset, height, view.rowCount)
  return (
    <Box flexDirection="column">
      {view.rows({ start, end: start + height }).map((row, index) => (
        <Box key={start + index}>{renderRow(row, start + index)}</Box>
      ))}
    </Box>
  )
}

/** Window math shared by every list in the TUI. */
export namespace WindowedList {
  /** Text of an empty view. */
  export const DefaultEmptyText = "(no rows)"

  /**
   * Clamp an offset so the window stays inside `[0, count)`.
   *
   * @param offset - Requested first index.
   * @param height - Visible rows.
   * @param count - Total rows.
   * @returns The clamped offset.
   */
  export function clampOffset(offset: number, height: number, count: number): number {
    return clampIndex(offset, count - height + 1)
  }

  /**
   * The offset that keeps `cursor` visible, centred where possible.
   *
   * @param cursor - Selected index.
   * @param height - Visible rows.
   * @param count - Total rows.
   * @returns The offset.
   */
  export function offsetFor(cursor: number, height: number, count: number): number {
    return clampOffset(cursor - Math.floor(height / 2), height, count)
  }

  /**
   * The visible slice of a plain list (history, saved queries, schema tree).
   *
   * @param items - Every item.
   * @param cursor - Selected index.
   * @param height - Visible rows.
   * @returns The offset and the visible items.
   */
  export function window<T>(items: readonly T[], cursor: number, height: number): VisibleWindow<T> {
    const offset = offsetFor(cursor, height, items.length)
    return { offset, items: items.slice(offset, offset + height) }
  }
}

/** A visible window of a plain list. */
export interface VisibleWindow<T> {
  /** Index of the first visible item. */
  offset: number
  /** The visible items. */
  items: T[]
}
