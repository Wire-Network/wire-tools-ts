import { useState } from "react"
import Button from "@mui/material/Button"
import Checkbox from "@mui/material/Checkbox"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import FormControlLabel from "@mui/material/FormControlLabel"
import MenuItem from "@mui/material/MenuItem"
import Radio from "@mui/material/Radio"
import RadioGroup from "@mui/material/RadioGroup"
import TextField from "@mui/material/TextField"

import { OutputFormat } from "@wireio/ql-shared"

import { ExportScope, exportResults, UiActions, UiSurface, useAppDispatch, useSurface, type ExportOptions } from "../store/index.js"

/**
 * Export the focused result in any `OutputFormat` (incl. tsv / html / xml):
 * scope this page or All (one unpaged request), header toggle. The renderer
 * renders; main writes the file chosen in the native save dialog.
 *
 * @returns The dialog.
 */
export function ExportDialog() {
  const dispatch = useAppDispatch(),
    open = useSurface(UiSurface.export),
    [options, setOptions] = useState<ExportOptions>(ExportDialog.defaultOptions()),
    close = () => dispatch(UiActions.surfaceClosed(UiSurface.export))
  return (
    <Dialog open={open} onClose={close}>
      <DialogTitle>Export Results</DialogTitle>
      <DialogContent>
        <TextField
          select
          label="Format"
          value={options.format}
          fullWidth
          margin="dense"
          onChange={event => setOptions({ ...options, format: event.target.value as OutputFormat })}
        >
          {Object.values(OutputFormat).map(format => (
            <MenuItem key={format} value={format}>
              {format}
            </MenuItem>
          ))}
        </TextField>
        <RadioGroup
          row
          value={options.scope}
          onChange={event => setOptions({ ...options, scope: event.target.value as ExportScope })}
        >
          <FormControlLabel value={ExportScope.page} control={<Radio size="small" />} label="This page" />
          <FormControlLabel value={ExportScope.all} control={<Radio size="small" />} label="All rows (one request)" />
        </RadioGroup>
        <FormControlLabel
          control={<Checkbox size="small" checked={options.header} onChange={event => setOptions({ ...options, header: event.target.checked })} />}
          label="Header row"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="contained"
          onClick={() => {
            close()
            void dispatch(exportResults(options))
          }}
        >
          Export…
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** Export defaults. */
export namespace ExportDialog {
  /**
   * The initial choices.
   *
   * @returns CSV, this page, with header.
   */
  export function defaultOptions(): ExportOptions {
    return { format: OutputFormat.csv, scope: ExportScope.page, header: true }
  }
}
