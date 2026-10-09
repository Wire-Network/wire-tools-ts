import type { MouseEvent } from "react"
import Button from "@mui/material/Button"
import ListItemButton from "@mui/material/ListItemButton"
import ListItemText from "@mui/material/ListItemText"

import { PlatformFonts } from "../../theme/index.js"
import { QueryDrawer } from "./QueryDrawer.js"

/** Props of {@link QueryListItem}. */
export interface QueryListItemProps {
  /** First line. */
  primary: string
  /** Second line. */
  secondary: string
  /** Render the primary line as SQL (monospace) — history entries. */
  primaryIsQuery?: boolean
  /** What the re-run / delete buttons' accessible names append (an id or a name). */
  identity: string
  /** Click: open the query in a new editor tab. */
  onOpen: () => void
  /** Re-run: open it in a new tab and run it. */
  onRerun: () => void
  /** Delete (omitted = no delete button). */
  onDelete?: () => void
}

/**
 * One stored query in a {@link QueryDrawer}: click opens it in a new tab; the
 * Re-run button opens and runs it; an optional Delete.
 *
 * @param props - Texts and actions.
 * @returns The item.
 */
export function QueryListItem({ primary, secondary, primaryIsQuery = false, identity, onOpen, onRerun, onDelete }: QueryListItemProps) {
  const stopping = (action: () => void) => (event: MouseEvent) => {
    event.stopPropagation()
    action()
  }
  return (
    <ListItemButton onClick={onOpen}>
      <ListItemText
        primary={primary}
        secondary={secondary}
        slotProps={{
          primary: { noWrap: true, sx: primaryIsQuery ? { fontFamily: PlatformFonts.Monospace } : undefined },
          secondary: { noWrap: true }
        }}
      />
      <Button size="small" aria-label={`${QueryDrawer.RerunLabel} ${identity}`} onClick={stopping(onRerun)}>
        {QueryDrawer.RerunLabel}
      </Button>
      {onDelete != null && (
        <Button size="small" color="error" aria-label={`${QueryDrawer.DeleteLabel} ${identity}`} onClick={stopping(onDelete)}>
          {QueryDrawer.DeleteLabel}
        </Button>
      )}
    </ListItemButton>
  )
}
