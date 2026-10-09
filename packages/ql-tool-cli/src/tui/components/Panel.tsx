import type { ReactNode } from "react"
import { Box, Text } from "ink"

import { TuiColorRole, TuiPalette } from "../editor/index.js"

/** Props of {@link Panel}. */
export interface PanelProps {
  /** Title in the top border line. */
  title: string
  /** Focused panels use the brand color. */
  focused?: boolean
  /** Fixed width (columns). */
  width?: number
  /** Fixed height (rows). */
  height?: number
  /** Flex grow factor. */
  flexGrow?: number
  /** Content. */
  children?: ReactNode
}

/**
 * A titled, bordered region; the focused one is drawn in the Wire brand blue.
 *
 * @param props - Title, focus, size and content.
 * @returns The panel element.
 */
export function Panel({ title, focused = false, width, height, flexGrow, children }: PanelProps) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={TuiPalette[focused ? TuiColorRole.brand : TuiColorRole.muted]}
      width={width}
      height={height}
      flexGrow={flexGrow}
    >
      <Text bold color={focused ? TuiPalette[TuiColorRole.brand] : undefined}>
        {title}
      </Text>
      {children}
    </Box>
  )
}
