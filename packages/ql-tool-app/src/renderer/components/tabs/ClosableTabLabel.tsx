import type { MouseEvent, ReactNode } from "react"
import CloseIcon from "@mui/icons-material/Close"
import Box from "@mui/material/Box"
import IconButton from "@mui/material/IconButton"

/** One tab-label action button (pin, close). */
export interface TabLabelAction {
  /** Accessible name (`Close Query 1`, `Pin Result 2`). */
  label: string
  /** The icon. */
  icon: ReactNode
  /** Runs on click / Enter / Space (the tab itself is not selected). */
  onAction: () => void
}

/** Props of {@link ClosableTabLabel}. */
export interface ClosableTabLabelProps {
  /** The tab's title text. */
  title: ReactNode
  /** Accessible name of the close button. */
  closeLabel: string
  /** Close the tab. */
  onClose: () => void
  /** Buttons shown before the close button (e.g. pin). */
  actions?: TabLabelAction[]
}

/**
 * A tab label with keyboard-reachable icon buttons (tab stop, Enter / Space)
 * and a close button last — the ONE label of the editor and result tab strips.
 * The buttons render as spans (`component="span"`): a MUI `Tab` is already a
 * `<button>`, which may not contain another; their clicks never select the tab.
 *
 * @param props - Title, close and extra actions.
 * @returns The label.
 */
export function ClosableTabLabel({ title, closeLabel, onClose, actions = [] }: ClosableTabLabelProps) {
  const buttons: TabLabelAction[] = [...actions, { label: closeLabel, icon: <CloseIcon fontSize="inherit" />, onAction: onClose }]
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      {title}
      {buttons.map(button => (
        <IconButton
          key={button.label}
          component="span"
          size="small"
          aria-label={button.label}
          sx={{ p: ClosableTabLabel.ButtonPadding, fontSize: "inherit" }}
          onClick={(event: MouseEvent) => {
            event.stopPropagation()
            button.onAction()
          }}
        >
          {button.icon}
        </IconButton>
      ))}
    </Box>
  )
}

/** Tab-label geometry. */
export namespace ClosableTabLabel {
  /** Padding of a label button (theme spacing units) — compact inside a 32px tab. */
  export const ButtonPadding = 0.25
}
