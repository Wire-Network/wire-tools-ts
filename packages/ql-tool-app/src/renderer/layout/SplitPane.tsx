import { useRef, useState, type PointerEvent, type ReactNode } from "react"
import Box from "@mui/material/Box"

/** Split orientation (identity enum). */
export enum SplitDirection {
  /** Side by side (vertical divider). */
  row = "row",
  /** Stacked (horizontal divider). */
  column = "column"
}

/** Props of {@link SplitPane}. */
export interface SplitPaneProps {
  /** Orientation. */
  direction: SplitDirection
  /** Initial size of the first pane (px). */
  initialSize: number
  /** Minimum size of either pane (px). */
  minSize?: number
  /** First pane. */
  first: ReactNode
  /** Second pane. */
  second: ReactNode
  /** Test id. */
  testId?: string
}

/**
 * Two panes with a draggable divider (pointer capture; no layout library).
 *
 * @param props - Orientation, sizes, panes.
 * @returns The split.
 */
export function SplitPane({ direction, initialSize, minSize = SplitPane.DefaultMinSize, first, second, testId }: SplitPaneProps) {
  const [size, setSize] = useState(initialSize),
    containerRef = useRef<HTMLDivElement>(null),
    row = direction === SplitDirection.row,
    onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId) || containerRef.current == null) return
      const bounds = containerRef.current.getBoundingClientRect(),
        total = row ? bounds.width : bounds.height,
        offset = row ? event.clientX - bounds.left : event.clientY - bounds.top
      setSize(Math.min(Math.max(offset, minSize), total - minSize))
    }
  return (
    <Box
      ref={containerRef}
      data-testid={testId}
      sx={{ display: "flex", flexDirection: direction, width: "100%", height: "100%", minHeight: 0, minWidth: 0 }}
    >
      <Box sx={{ flex: `0 0 ${size}px`, minHeight: 0, minWidth: 0, overflow: "hidden" }}>{first}</Box>
      <Box
        role="separator"
        aria-orientation={row ? "vertical" : "horizontal"}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
        onPointerMove={onPointerMove}
        sx={{
          flex: `0 0 ${SplitPane.DividerPx}px`,
          cursor: row ? "col-resize" : "row-resize",
          bgcolor: "divider"
        }}
      />
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden" }}>{second}</Box>
    </Box>
  )
}

/** Split-pane constants. */
export namespace SplitPane {
  /** Divider thickness (px). */
  export const DividerPx = 4
  /** Default minimum pane size (px). */
  export const DefaultMinSize = 120
}
