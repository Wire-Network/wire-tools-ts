import { useEffect } from "react"
import CssBaseline from "@mui/material/CssBaseline"
import { ThemeProvider } from "@mui/material/styles"
import { Provider } from "react-redux"

import { getLogger } from "@wireio/shared"

import type { QLBridge } from "../common/index.js"
import { PanelErrorBoundary } from "./components/index.js"
import { MenuActions } from "./ipc/index.js"
import { WorkbenchLayout } from "./layout/index.js"
import type { QueryPortClient } from "./query/index.js"
import {
  ConnectionsActions,
  loadHistory,
  loadProfiles,
  loadSaved,
  type WorkbenchStore
} from "./store/index.js"
import { createQLTheme } from "./theme/index.js"

const log = getLogger(__filename)

/** Props of {@link App}. */
export interface AppProps {
  /** The renderer store. */
  store: WorkbenchStore
  /** The preload bridge. */
  bridge: QLBridge
  /** The query-port client (started here). */
  queryPort: QueryPortClient
}

/** The one theme instance (CSS variables; media-query color scheme). */
const theme = createQLTheme()

/**
 * The workbench root: store + theme providers; on mount it starts the query
 * port (receiver registered before the port request), routes menu actions and
 * store-change events, and loads profiles / history / saved queries.
 *
 * @param props - Store, bridge, query port.
 * @returns The app.
 */
export function App({ store, bridge, queryPort }: AppProps) {
  useEffect(() => {
    const stopStatus = queryPort.onStatus(status => store.dispatch(ConnectionsActions.portStatusChanged(status))),
      stopPort = queryPort.start(),
      stopMenu = MenuActions.subscribe({ dispatch: store.dispatch, getState: store.getState, bridge, queryPort })
    store.dispatch(ConnectionsActions.portStatusChanged(queryPort.status))
    void store.dispatch(loadProfiles())
    void store.dispatch(loadHistory())
    void store.dispatch(loadSaved())
    log.info("workbench mounted")
    return () => {
      stopMenu()
      stopPort()
      stopStatus()
    }
  }, [store, bridge, queryPort])
  return (
    <Provider store={store}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <PanelErrorBoundary panel="Workbench">
          <WorkbenchLayout queryPort={queryPort} />
        </PanelErrorBoundary>
      </ThemeProvider>
    </Provider>
  )
}
