import AddIcon from "@mui/icons-material/Add"
import Box from "@mui/material/Box"
import IconButton from "@mui/material/IconButton"
import Tab from "@mui/material/Tab"
import Tabs from "@mui/material/Tabs"
import Tooltip from "@mui/material/Tooltip"

import { ActionRegistry, AppAction } from "../../common/index.js"
import { ClosableTabLabel } from "../components/index.js"
import { useAppDispatch, useAppSelector, WorkspaceActions } from "../store/index.js"

/** The SQL editor tab strip (new / close / switch). */
export function EditorTabs() {
  const dispatch = useAppDispatch(),
    { tabs, activeTabId } = useAppSelector(state => state.workspace)
  return (
    <Box sx={{ display: "flex", alignItems: "center", borderBottom: 1, borderColor: "divider" }}>
      <Tabs
        value={activeTabId}
        onChange={(_event, id: string) => dispatch(WorkspaceActions.tabActivated(id))}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ flex: 1 }}
      >
        {tabs.map(tab => (
          <Tab
            key={tab.id}
            value={tab.id}
            data-testid={`editor-tab-${tab.id}`}
            label={
              <ClosableTabLabel
                title={tab.title}
                closeLabel={`Close ${tab.title}`}
                onClose={() => dispatch(WorkspaceActions.tabClosed(tab.id))}
              />
            }
          />
        ))}
      </Tabs>
      <Tooltip title={ActionRegistry.tooltip(AppAction.newTab)}>
        <IconButton aria-label="New query tab" onClick={() => dispatch(WorkspaceActions.tabAdded({}))}>
          <AddIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  )
}
