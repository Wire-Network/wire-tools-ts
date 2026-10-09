import { useState } from "react"
import ViewColumnIcon from "@mui/icons-material/ViewColumn"
import Checkbox from "@mui/material/Checkbox"
import IconButton from "@mui/material/IconButton"
import ListItemText from "@mui/material/ListItemText"
import Menu from "@mui/material/Menu"
import MenuItem from "@mui/material/MenuItem"
import Tooltip from "@mui/material/Tooltip"

import type { QueryColumn } from "@wireio/ql-shared"

import { ResultsActions, useAppDispatch, type ResultTab } from "../store/index.js"

/** Props of {@link ColumnChooser}. */
export interface ColumnChooserProps {
  /** The result tab. */
  tab: ResultTab
  /** Every column of the result. */
  columns: QueryColumn[]
}

/**
 * Show/hide result columns (client-side projection; at least one stays visible).
 *
 * @param props - Tab and columns.
 * @returns The chooser.
 */
export function ColumnChooser({ tab, columns }: ColumnChooserProps) {
  const dispatch = useAppDispatch(),
    [anchor, setAnchor] = useState<HTMLElement>(null),
    hidden = tab.view.hiddenColumns,
    toggle = (name: string) => {
      const next = hidden.includes(name) ? hidden.filter(column => column !== name) : [...hidden, name]
      if (next.length >= columns.length) return
      dispatch(ResultsActions.viewPatched({ resultId: tab.id, patch: { hiddenColumns: next } }))
    }
  return (
    <>
      <Tooltip title="Columns">
        <IconButton aria-label="Columns" onClick={event => setAnchor(event.currentTarget)}>
          <ViewColumnIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchor} open={anchor != null} onClose={() => setAnchor(null)}>
        {columns.map(column => (
          <MenuItem key={column.name} dense onClick={() => toggle(column.name)}>
            <Checkbox size="small" checked={!hidden.includes(column.name)} />
            <ListItemText primary={column.name} secondary={column.logical_type} />
          </MenuItem>
        ))}
      </Menu>
    </>
  )
}
