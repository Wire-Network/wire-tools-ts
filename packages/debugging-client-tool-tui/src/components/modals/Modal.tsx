import React from "react"
import { Box, Text } from "ink"

/** Props for the generic {@link Modal} container. */
export interface ModalProps {
  /** Title rendered in the modal's header band. */
  title: string
  /** Border color — `red` for destructive, `cyan` for informational, etc. */
  borderColor?: string
  /** Modal body (message / inputs / hotkey hints). */
  children?: React.ReactNode
}

/**
 * Minimal, dependency-free modal wrapper — a bordered, centered box.
 * Rendering this replaces the route content; `App` picks which is visible.
 * Future upgrades (true overlay, z-index, etc.) can refactor this one spot.
 */
export function Modal(props: ModalProps): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1} alignItems="center" justifyContent="center">
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor={props.borderColor ?? "cyan"}
        paddingX={2}
        paddingY={1}
      >
        <Text bold color={props.borderColor ?? "cyan"}>
          {props.title}
        </Text>
        <Box marginTop={1}>{props.children}</Box>
      </Box>
    </Box>
  )
}
