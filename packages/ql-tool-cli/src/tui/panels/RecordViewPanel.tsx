import { Box, Text } from "ink"

import { CellFormatter } from "@wireio/ql-shared"

import { selectCursorRow, selectResultView, useAppSelector } from "../store/index.js"

/**
 * The cursor row as one `column: value` line per column (Alt+V).
 *
 * @returns The panel element.
 */
export function RecordViewPanel() {
  const cursorRow = useAppSelector(state => selectCursorRow(state.results)),
    view = useAppSelector(state => selectResultView(state.results))
  if (cursorRow == null) return <Text dimColor>{RecordViewPanel.EmptyText}</Text>
  const row = view.row(cursorRow)
  return (
    <Box flexDirection="column">
      <Text dimColor>{`record ${cursorRow + 1} of ${view.rowCount}`}</Text>
      {view.columns.map(column => (
        <Text key={column.name} wrap="truncate">
          <Text bold>{`${column.name}: `}</Text>
          {CellFormatter.format(column, row[column.name])}
        </Text>
      ))}
    </Box>
  )
}

/** Record view constants. */
export namespace RecordViewPanel {
  /** Shown without rows. */
  export const EmptyText = "no row selected"
}
