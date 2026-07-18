import React from "react"
import { Text } from "ink"
import {
  colorForLevel,
  formatLocation,
  formatTimestamp,
  parseJsonLogLine,
  type JsonLogRecord,
  type LogLevelColor
} from "@wireio/debugging-shared"
import {
  LineRender,
  renderWithHighlight,
  sliceForHorizontalOffset
} from "../util/lineRender.js"

export interface LogViewerJSONLineProps {
  /** Raw line read from the file. May or may not be valid JSON. */
  line: string
  /** Number of leading characters dropped from the entire row (panel-level). */
  horizontalOffset: number
  /** Search term — substring matches in the message are highlighted. Empty disables. */
  highlight: string
  /** When true, the source-location column is rendered between category and msg. */
  locationVisible: boolean
}

/**
 * One rendered column. `text` already includes the trailing column-separator
 * spaces — there are no inter-segment spacers to track when applying the
 * panel-wide horizontal offset.
 */
interface ColumnSegment {
  text: string
  color?: LogLevelColor
  dim?: boolean
  /** When true, a non-empty highlight term is applied to this segment's visible slice. */
  highlight?: boolean
}

/**
 * Render one JSONL log line as a fixed-width column row:
 *
 *   `HH:mm:ss.SSS  level  [category]  [location?]  msg…`
 *
 * The horizontal pan is applied to the entire composed row so all columns
 * scroll together — exactly the same offset that every other visible row sees,
 * because the offset is panel-level (Redux). Falls back to a dimmed verbatim
 * render when the line isn't valid JSON or doesn't match the {@link JsonLogRecord} shape.
 */
export function LogViewerJSONLine(
  props: LogViewerJSONLineProps
): React.ReactElement {
  const parsed = parseJsonLogLine(props.line)
  if (typeof parsed === "string") {
    return (
      <Text dimColor wrap={LineRender.TruncateMode}>
        {sliceForHorizontalOffset(parsed, props.horizontalOffset)}
      </Text>
    )
  }
  const segments = composeSegments(parsed, props.locationVisible)
  return (
    <Text wrap={LineRender.TruncateMode}>
      {renderColumnsWithOffset(
        segments,
        props.horizontalOffset,
        props.highlight
      )}
    </Text>
  )
}

/** Assemble the column-segment list for a parsed record. */
function composeSegments(
  record: JsonLogRecord,
  locationVisible: boolean
): ColumnSegment[] {
  const namespace = LogViewerJSONLine,
    timestamp = padToWidth(
      formatTimestamp(record.ts),
      namespace.TimestampWidth
    ),
    level = padToWidth(record.lvl.toLowerCase(), namespace.LevelWidth),
    category = padToWidth(`[${record.logger}]`, namespace.CategoryWidth),
    location = padToWidth(
      `[${formatLocation(record)}]`,
      namespace.LocationWidth
    ),
    sep = namespace.ColumnSeparator
  const head: ColumnSegment[] = [
    { text: timestamp + sep, dim: true },
    { text: level + sep, color: colorForLevel(record.lvl) },
    { text: category + sep, dim: true }
  ]
  const middle: ColumnSegment[] = locationVisible
    ? [{ text: location + sep, dim: true }]
    : []
  const tail: ColumnSegment[] = [{ text: record.msg, highlight: true }]
  return [...head, ...middle, ...tail]
}

/**
 * Walk `segments` left-to-right, dropping any segment whose right edge sits
 * before `horizontalOffset` and slicing the first partially-visible segment so
 * the rendered row begins exactly at the offset position. Subsequent segments
 * render in full.
 */
function renderColumnsWithOffset(
  segments: ColumnSegment[],
  horizontalOffset: number,
  highlight: string
): React.ReactNode {
  const initial: { cursor: number; nodes: React.ReactNode[] } = {
      cursor: 0,
      nodes: []
    },
    folded = segments.reduce((acc, seg, i) => {
      const segStart = acc.cursor,
        segEnd = segStart + seg.text.length
      if (segEnd <= horizontalOffset) {
        return { cursor: segEnd, nodes: acc.nodes }
      }
      const visible =
          horizontalOffset > segStart
            ? seg.text.slice(horizontalOffset - segStart)
            : seg.text,
        body =
          seg.highlight && highlight.length > 0
            ? renderWithHighlight(visible, highlight)
            : visible,
        rendered = (
          <Text key={i} color={seg.color} dimColor={seg.dim ?? false}>
            {body}
          </Text>
        )
      return { cursor: segEnd, nodes: [...acc.nodes, rendered] }
    }, initial)
  return <>{folded.nodes}</>
}

/**
 * Right-pad with spaces to `width`. Truncates if the input is wider so columns
 * never push downstream alignment off — the truncated content was always at
 * a fixed-width column boundary so the lost characters were going to be hidden
 * by the next column anyway.
 */
function padToWidth(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s.padEnd(width)
}

export namespace LogViewerJSONLine {
  /** Width of the `HH:mm:ss.SSS` timestamp column. */
  export const TimestampWidth = 12
  /** Width of the level column — `trace`/`debug`/`info`/`warn`/`error`/`fatal` ≤ 5. */
  export const LevelWidth = 5
  /** Width of the bracketed category (logger name). Tuned to fit `[transient_trx_failure_tracing]`. */
  export const CategoryWidth = 31
  /** Width of the bracketed source-location column when visible. */
  export const LocationWidth = 32
  /** Inter-column separator — single space, included in each segment's trailing pad. */
  export const ColumnSeparator = " " as const
}

/**
 * Column-start byte offsets within a rendered JSONL row, given the current
 * `locationVisible` setting. Used by the panel's ←/→ handlers so a single
 * arrow press snaps the horizontal pan to the next/prev column boundary.
 *
 * Layout: time(12) sep level(5) sep [logger](31) sep [location](32, optional) sep msg
 */
export function jsonColumnBoundaries(
  locationVisible: boolean
): readonly number[] {
  const sep = LogViewerJSONLine.ColumnSeparator.length,
    timeStart = 0,
    levelStart = timeStart + LogViewerJSONLine.TimestampWidth + sep,
    categoryStart = levelStart + LogViewerJSONLine.LevelWidth + sep,
    afterCategory = categoryStart + LogViewerJSONLine.CategoryWidth + sep,
    msgStart = locationVisible
      ? afterCategory + LogViewerJSONLine.LocationWidth + sep
      : afterCategory
  return locationVisible
    ? [timeStart, levelStart, categoryStart, afterCategory, msgStart]
    : [timeStart, levelStart, categoryStart, msgStart]
}

/**
 * Snap a horizontal-offset value to the next column boundary. Past the last
 * boundary (deep in `msg`) we fall back to a small fixed step so the user can
 * still scroll the message text with ←/→.
 */
export function nextColumnOffset(
  boundaries: readonly number[],
  current: number,
  fallbackStep: number
): number {
  const next = boundaries.find(b => b > current)
  return next ?? current + fallbackStep
}

/**
 * Snap a horizontal-offset value to the previous column boundary. When the
 * user is far inside `msg` (past the last boundary by more than `fallbackStep`)
 * we step backwards by that fixed amount instead of jumping all the way back
 * to `msgStart` — keeps fine-grained scrolling intuitive.
 */
export function prevColumnOffset(
  boundaries: readonly number[],
  current: number,
  fallbackStep: number
): number {
  if (current <= 0) return 0
  const lastBoundary = boundaries[boundaries.length - 1] ?? 0
  if (current > lastBoundary + fallbackStep) {
    return Math.max(lastBoundary, current - fallbackStep)
  }
  const before = boundaries.filter(b => b < current)
  return before.length === 0 ? 0 : Math.max(...before)
}
