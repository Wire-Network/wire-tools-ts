import React from "react"
import { Box } from "ink"
import type { RouteComponentProps } from "../../../router/RouteTypes.js"
import { LogViewerPanel } from "../panels/LogViewerPanel.js"
import { ProcessMonitorPanel } from "../panels/ProcessMonitorPanel.js"

/**
 * Full-screen view for the Process Monitor feature. Two panels stacked
 * vertically: the process list on top, the log viewer below. Both panels
 * use Ink's focus system internally so arrow keys only affect the focused
 * panel.
 */
export function ProcessMonitorRoute(_: RouteComponentProps): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexDirection="column" flexGrow={1}>
        <ProcessMonitorPanel />
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        <LogViewerPanel />
      </Box>
    </Box>
  )
}
