import { useState } from "react"
import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore"
import NavigateNextIcon from "@mui/icons-material/NavigateNext"
import Box from "@mui/material/Box"
import IconButton from "@mui/material/IconButton"
import Typography from "@mui/material/Typography"

import { CellFormatter, type ResultView } from "@wireio/ql-shared"

import { KeyValueTable } from "./KeyValueTable.js"

/** Props of {@link FormResultView}. */
export interface FormResultViewProps {
  /** The view browsed. */
  view: ResultView
}

/**
 * One record at a time (column → formatted value), with previous/next.
 *
 * @param props - The view.
 * @returns The form view.
 */
export function FormResultView({ view }: FormResultViewProps) {
  const [index, setIndex] = useState(0),
    current = Math.min(index, Math.max(view.rowCount - 1, 0))
  if (view.rowCount === 0) return <Typography sx={{ p: 2 }}>No rows</Typography>
  const row = view.row(current)
  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1 }}>
        <IconButton aria-label="Previous record" disabled={current === 0} onClick={() => setIndex(current - 1)}>
          <NavigateBeforeIcon fontSize="small" />
        </IconButton>
        <Typography variant="body2">{`record ${current + 1} of ${view.rowCount}`}</Typography>
        <IconButton
          aria-label="Next record"
          disabled={current >= view.rowCount - 1}
          onClick={() => setIndex(current + 1)}
        >
          <NavigateNextIcon fontSize="small" />
        </IconButton>
      </Box>
      <KeyValueTable
        testId="form-view"
        entries={view.columns.map(column => ({ label: column.name, value: CellFormatter.format(column, row[column.name]) }))}
      />
    </Box>
  )
}
