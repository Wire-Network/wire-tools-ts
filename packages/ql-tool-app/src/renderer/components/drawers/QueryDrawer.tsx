import type { ReactNode } from "react"
import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import Drawer from "@mui/material/Drawer"
import List from "@mui/material/List"
import Typography from "@mui/material/Typography"

import { UiActions, useAppDispatch, useSurface, type UiSurface } from "../../store/index.js"

/** Props of {@link QueryDrawer}. */
export interface QueryDrawerProps {
  /** The surface that opens / closes it. */
  surface: UiSurface
  /** Heading. */
  title: string
  /** Header buttons shown before Close. */
  actions?: ReactNode
  /** Content between the header and the list (e.g. a search field). */
  toolbar?: ReactNode
  /** Test id of the list. */
  listTestId: string
  /** The {@link QueryListItem}s. */
  children: ReactNode
}

/**
 * The right-hand drawer of stored queries — the ONE frame of the history and
 * saved-queries panels: heading, header buttons, Close, an optional toolbar and the list.
 *
 * @param props - Surface, title, actions, toolbar and items.
 * @returns The drawer.
 */
export function QueryDrawer({ surface, title, actions, toolbar, listTestId, children }: QueryDrawerProps) {
  const dispatch = useAppDispatch(),
    open = useSurface(surface)
  return (
    <Drawer anchor="right" variant="persistent" open={open} slotProps={{ paper: { sx: { width: QueryDrawer.WidthPx } } }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, p: 1 }}>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          {title}
        </Typography>
        {actions}
        <Button size="small" onClick={() => dispatch(UiActions.surfaceClosed(surface))}>
          {QueryDrawer.CloseLabel}
        </Button>
      </Box>
      {toolbar}
      <List dense data-testid={listTestId}>
        {children}
      </List>
    </Drawer>
  )
}

/** Drawer constants shared by the history and saved-queries panels. */
export namespace QueryDrawer {
  /** Drawer width (px). */
  export const WidthPx = 360
  /** Label of the close button. */
  export const CloseLabel = "Close"
  /** Label of the per-entry re-run button (its accessible name appends the entry's identity). */
  export const RerunLabel = "Re-run"
  /** Label of the per-entry delete button. */
  export const DeleteLabel = "Delete"
}
