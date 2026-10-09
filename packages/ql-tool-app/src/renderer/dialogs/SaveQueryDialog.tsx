import { useState } from "react"
import Button from "@mui/material/Button"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import TextField from "@mui/material/TextField"

import { saveCurrentQuery, UiActions, UiSurface, useAppDispatch, useSurface } from "../store/index.js"

/**
 * Save the focused editor's SQL as a named saved query (same name = update).
 *
 * @returns The dialog.
 */
export function SaveQueryDialog() {
  const dispatch = useAppDispatch(),
    open = useSurface(UiSurface.saveQuery),
    [name, setName] = useState(""),
    close = () => dispatch(UiActions.surfaceClosed(UiSurface.saveQuery))
  return (
    <Dialog open={open} onClose={close}>
      <DialogTitle>Save Query</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          label="Name"
          value={name}
          fullWidth
          margin="dense"
          onChange={event => setName(event.target.value)}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button
          variant="contained"
          disabled={name.trim().length === 0}
          onClick={() => {
            close()
            void dispatch(saveCurrentQuery(name.trim()))
          }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}
