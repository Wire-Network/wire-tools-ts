import { Box, Text } from "ink"

import { QLBrand, ResultSummary } from "@wireio/ql-shared"

import { TuiColorRole, TuiPalette } from "../editor/index.js"
import { KeyBindings, TuiAction } from "../keys/index.js"
import { useTuiNavigation } from "../routing/index.js"

/**
 * `WIRE QL` in the brand blue, the current route, and the help hint.
 *
 * @returns The header element.
 */
export function HeaderBar() {
  const { router } = useTuiNavigation()
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text bold color={TuiPalette[TuiColorRole.brand]}>
          {QLBrand.ProductName}
        </Text>
        <Text dimColor>{`${ResultSummary.Separator}${router.current}`}</Text>
      </Text>
      <Text dimColor>{HeaderBar.HelpHint}</Text>
    </Box>
  )
}

/** Header constants. */
export namespace HeaderBar {
  /** Right-aligned hint. */
  export const HelpHint = ResultSummary.join([
    `${KeyBindings.labelOf(TuiAction.help)} help`,
    `${KeyBindings.labelOf(TuiAction.quit)} quit`
  ])
}
