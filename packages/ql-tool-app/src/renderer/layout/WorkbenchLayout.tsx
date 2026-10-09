import Box from "@mui/material/Box"
import Snackbar from "@mui/material/Snackbar"

import { PanelErrorBoundary } from "../components/index.js"
import { ConnectionManagerDialog, ExportDialog, SaveQueryDialog } from "../dialogs/index.js"
import { EditorTabs, QueryEditor } from "../editor/index.js"
import { HistoryPanel } from "../history/index.js"
import { SchemaNavigator } from "../navigator/index.js"
import type { QueryPortClient } from "../query/index.js"
import { ResultsPanel } from "../results/index.js"
import { SavedQueriesPanel } from "../saved/index.js"
import { UiActions, useAppDispatch, useAppSelector } from "../store/index.js"
import { SplitDirection, SplitPane } from "./SplitPane.js"
import { StatusBar } from "./StatusBar.js"
import { Toolbar } from "./Toolbar.js"

/** Props of {@link WorkbenchLayout}. */
export interface WorkbenchLayoutProps {
  /** The query port (status-bar Restart). */
  queryPort: QueryPortClient
}

/**
 * The MySQL-Workbench-style layout: toolbar; navigator | (editor tabs + editor /
 * results); history + saved drawers; dialogs; status bar.
 *
 * @param props - The query port.
 * @returns The layout.
 */
export function WorkbenchLayout({ queryPort }: WorkbenchLayoutProps) {
  const dispatch = useAppDispatch(),
    notice = useAppSelector(state => state.ui.notice)
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100vh", bgcolor: "background.default" }}>
      <Toolbar />
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <SplitPane
          direction={SplitDirection.row}
          initialSize={WorkbenchLayout.NavigatorWidthPx}
          first={
            <PanelErrorBoundary panel="Navigator">
              <SchemaNavigator />
            </PanelErrorBoundary>
          }
          second={
            <SplitPane
              direction={SplitDirection.column}
              initialSize={WorkbenchLayout.EditorHeightPx}
              first={
                <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
                  <EditorTabs />
                  <Box sx={{ flex: 1, minHeight: 0 }} data-testid="query-editor">
                    <PanelErrorBoundary panel="Editor">
                      <QueryEditor />
                    </PanelErrorBoundary>
                  </Box>
                </Box>
              }
              second={
                <PanelErrorBoundary panel="Results">
                  <ResultsPanel />
                </PanelErrorBoundary>
              }
            />
          }
        />
      </Box>
      <StatusBar queryPort={queryPort} />
      <HistoryPanel />
      <SavedQueriesPanel />
      <ConnectionManagerDialog />
      <ExportDialog />
      <SaveQueryDialog />
      <Snackbar
        open={notice != null}
        message={notice}
        autoHideDuration={WorkbenchLayout.NoticeMs}
        onClose={() => dispatch(UiActions.noticeChanged(null))}
      />
    </Box>
  )
}

/** Layout geometry. */
export namespace WorkbenchLayout {
  /** Initial navigator width (px). */
  export const NavigatorWidthPx = 260
  /** Initial editor height (px). */
  export const EditorHeightPx = 300
  /** Notice display time (ms). */
  export const NoticeMs = 4_000
}
