import type { ReactNode } from "react"
import { Box, Text } from "ink"

import { TuiColorRole, TuiPalette } from "../editor/index.js"

/** Props of {@link ModalFrame}. */
export interface ModalFrameProps {
  /** Title line. */
  title: string
  /** Key hint line at the bottom. */
  keysHint: string
  /** Body. */
  children?: ReactNode
}

/**
 * The ONE modal chrome: a double brand border, a bold title, the body, and a dim
 * key hint.
 *
 * @param props - Title, hint and body.
 * @returns The frame element.
 */
export function ModalFrame({ title, keysHint, children }: ModalFrameProps) {
  return (
    <Box flexDirection="column" borderStyle="double" borderColor={TuiPalette[TuiColorRole.brand]}>
      <Text bold>{title}</Text>
      {children}
      <Text dimColor>{keysHint}</Text>
    </Box>
  )
}
