import Button from "@mui/material/Button"
import Dialog from "@mui/material/Dialog"
import DialogActions from "@mui/material/DialogActions"
import DialogContent from "@mui/material/DialogContent"
import DialogTitle from "@mui/material/DialogTitle"
import Typography from "@mui/material/Typography"

import { ValueInspector as Inspector, type ResultView } from "@wireio/ql-shared"

import { UiActions, useAppDispatch, useAppSelector } from "../store/index.js"
import { PlatformFonts } from "../theme/index.js"
import { KeyValueTable } from "./KeyValueTable.js"

/** Props of {@link ValueInspector}. */
export interface ValueInspectorProps {
  /** The view the inspected cell belongs to. */
  view: ResultView
}

/**
 * The value inspector dialog (cell double-click / context menu): `ValueInspector.inspect`
 * — JSON tree text, asset breakdown, raw + decoded hex, ISO time + epoch µs.
 *
 * @param props - The view.
 * @returns The dialog.
 */
export function ValueInspector({ view }: ValueInspectorProps) {
  const dispatch = useAppDispatch(),
    target = useAppSelector(state => state.ui.inspector),
    column = target == null ? null : view.columns.find(candidate => candidate.name === target.column),
    inspected = column == null || target.rowIndex >= view.rowCount ? null : Inspector.inspect(column, view.row(target.rowIndex)[column.name]),
    close = () => dispatch(UiActions.inspectorChanged(null))
  return (
    <Dialog open={inspected != null} onClose={close} maxWidth="md" fullWidth>
      <DialogTitle>{inspected == null ? "" : `${inspected.column} · ${inspected.logicalType} · ${inspected.kind}`}</DialogTitle>
      <DialogContent>
        <Typography
          component="pre"
          data-testid="inspector-display"
          sx={{ fontFamily: PlatformFonts.Monospace, whiteSpace: "pre-wrap" }}
        >
          {inspected?.display}
        </Typography>
        {inspected != null && inspected.fields.length > 0 && <KeyValueTable entries={inspected.fields} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
