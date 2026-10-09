import CodeIcon from "@mui/icons-material/Code"
import FileDownloadIcon from "@mui/icons-material/FileDownload"
import HistoryIcon from "@mui/icons-material/History"
import PlayArrowIcon from "@mui/icons-material/PlayArrow"
import PlaylistPlayIcon from "@mui/icons-material/PlaylistPlay"
import ReplayIcon from "@mui/icons-material/Replay"
import SettingsEthernetIcon from "@mui/icons-material/SettingsEthernet"
import StarBorderIcon from "@mui/icons-material/StarBorder"
import StopIcon from "@mui/icons-material/Stop"
import AppBar from "@mui/material/AppBar"
import Box from "@mui/material/Box"
import IconButton from "@mui/material/IconButton"
import MenuItem from "@mui/material/MenuItem"
import TextField from "@mui/material/TextField"
import MuiToolbar from "@mui/material/Toolbar"
import Tooltip from "@mui/material/Tooltip"
import Typography from "@mui/material/Typography"

import { QLBrand, QueryExecutionStatus, QueryFailureKind, QueryRetryPolicy, type QueryFailure } from "@wireio/ql-shared"

import { ActionRegistry, AppAction } from "../../common/index.js"
import { WireMarkIcon } from "../components/index.js"
import { QueryPortStatus } from "../query/index.js"
import {
  formatQuery,
  retryQuery,
  runQuery,
  selectActiveResult,
  selectProfile,
  stopQuery,
  ResultTabStatus,
  UiActions,
  UiSurface,
  useAppDispatch,
  useAppSelector
} from "../store/index.js"

/**
 * The workbench toolbar: Wire mark, connection selector, Run, Run selection,
 * Stop, Retry, explicit Offset / Limit, Format, Export, History, Saved.
 *
 * @returns The toolbar.
 */
export function Toolbar() {
  const dispatch = useAppDispatch(),
    { document, activeProfileName, portStatus } = useAppSelector(state => state.connections),
    windowFields = useAppSelector(state => state.ui.windowFields),
    result = useAppSelector(state => selectActiveResult(state.results)),
    running = result?.status === ResultTabStatus.running,
    failure = result?.execution?.status === QueryExecutionStatus.failure ? result.execution.failure : null,
    hostFailed = portStatus === QueryPortStatus.failed,
    canRun = activeProfileName != null && !running && !hostFailed
  return (
    <AppBar position="static">
      <MuiToolbar variant="dense" sx={{ gap: 1 }}>
        <WireMarkIcon whiteInDark />
        <Typography variant="subtitle2" sx={{ mr: 1 }}>
          {QLBrand.ProductName}
        </Typography>
        <TextField
          select
          value={activeProfileName ?? Toolbar.NoProfileValue}
          variant="standard"
          slotProps={{ select: { displayEmpty: true }, htmlInput: { "aria-label": "Connection" } }}
          onChange={event => void dispatch(selectProfile(String(event.target.value)))}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value={Toolbar.NoProfileValue} disabled>
            No connection
          </MenuItem>
          {document.profiles.map(profile => (
            <MenuItem key={profile.name} value={profile.name}>
              {profile.name}
            </MenuItem>
          ))}
        </TextField>
        <Tooltip title={ActionRegistry.tooltip(AppAction.connections)}>
          <IconButton aria-label="Connections" onClick={() => dispatch(UiActions.surfaceOpened(UiSurface.connections))}>
            <SettingsEthernetIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={ActionRegistry.tooltip(AppAction.run)}>
          <span>
            <IconButton aria-label="Run" color="primary" disabled={!canRun} onClick={() => void dispatch(runQuery(false))}>
              <PlayArrowIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={ActionRegistry.tooltip(AppAction.runSelection)}>
          <span>
            <IconButton aria-label="Run selection" disabled={!canRun} onClick={() => void dispatch(runQuery(true))}>
              <PlaylistPlayIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={ActionRegistry.tooltip(AppAction.stop)}>
          <span>
            <IconButton aria-label="Stop" disabled={!running} onClick={() => void dispatch(stopQuery())}>
              <StopIcon />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={ActionRegistry.tooltip(AppAction.retry)}>
          <span>
            <IconButton
              aria-label="Retry"
              disabled={running || hostFailed || !Toolbar.canRetry(failure)}
              onClick={() => void dispatch(retryQuery())}
            >
              <ReplayIcon />
            </IconButton>
          </span>
        </Tooltip>
        <TextField
          label="Offset"
          variant="standard"
          value={windowFields.offset}
          onChange={event => dispatch(UiActions.windowFieldsChanged({ ...windowFields, offset: event.target.value }))}
          sx={{ width: 80 }}
        />
        <TextField
          label="Limit"
          variant="standard"
          value={windowFields.limit}
          onChange={event => dispatch(UiActions.windowFieldsChanged({ ...windowFields, limit: event.target.value }))}
          sx={{ width: 80 }}
        />
        <Tooltip title={ActionRegistry.tooltip(AppAction.formatQuery)}>
          <IconButton aria-label="Format" onClick={() => void dispatch(formatQuery())}>
            <CodeIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={ActionRegistry.tooltip(AppAction.exportResults)}>
          <span>
            <IconButton
              aria-label="Export"
              disabled={result?.execution?.status !== QueryExecutionStatus.success}
              onClick={() => dispatch(UiActions.surfaceOpened(UiSurface.export))}
            >
              <FileDownloadIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={ActionRegistry.tooltip(AppAction.toggleHistory)}>
          <IconButton aria-label="History" onClick={() => dispatch(UiActions.surfaceToggled(UiSurface.history))}>
            <HistoryIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={ActionRegistry.tooltip(AppAction.toggleSaved)}>
          <IconButton aria-label="Saved queries" onClick={() => dispatch(UiActions.surfaceToggled(UiSurface.saved))}>
            <StarBorderIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </MuiToolbar>
    </AppBar>
  )
}

/** Toolbar constants + helpers. */
export namespace Toolbar {
  /** Select value standing for "no profile". */
  export const NoProfileValue = ""

  /**
   * Whether Retry is offered for a failure: the server's `retryable` flag for
   * engine failures; transport failures (lost port, host restart, network) can
   * always be re-sent; a user cancel is re-run with Run.
   *
   * @param failure - The failure.
   * @returns Whether Retry is enabled.
   */
  export function canRetry(failure: QueryFailure): boolean {
    return (
      failure != null &&
      (failure.kind === QueryFailureKind.transport ||
        (failure.kind === QueryFailureKind.engine && QueryRetryPolicy.canRetry(failure.data)))
    )
  }
}
