import React from "react"
import { Box } from "ink"
import type { RouteComponentProps } from "../../../router/RouteTypes.js"
import { EpochTrackerPanel } from "../panels/EpochTrackerPanel.js"

/**
 * Full-screen view for the OPP feature. Presently renders a single panel;
 * future preset layouts can compose additional panels / widgets by reaching
 * into `ComponentProviders` or by importing specific panel components.
 */
export function OPPRoute(_: RouteComponentProps): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <EpochTrackerPanel />
    </Box>
  )
}
