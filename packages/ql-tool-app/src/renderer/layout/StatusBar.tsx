import Box from "@mui/material/Box"
import Button from "@mui/material/Button"
import Typography from "@mui/material/Typography"
import { match } from "ts-pattern"

import { QueryExecutionStatus, ResultSummary, type QueryExecutionSuccess } from "@wireio/ql-shared"

import { QueryPortStatus, type QueryPortClient } from "../query/index.js"
import { selectActiveProfile, selectActiveResult, useAppSelector } from "../store/index.js"

/** Props of {@link StatusBar}. */
export interface StatusBarProps {
  /** The query port (Restart). */
  queryPort: QueryPortClient
}

/**
 * The status bar: connection endpoint, query-host state ("Query host failed —
 * Restart"), and the last outcome (rows, wall vs server time).
 *
 * @param props - The query port.
 * @returns The bar.
 */
export function StatusBar({ queryPort }: StatusBarProps) {
  const profile = useAppSelector(state => selectActiveProfile(state.connections)),
    portStatus = useAppSelector(state => state.connections.portStatus),
    result = useAppSelector(state => selectActiveResult(state.results)),
    execution = result?.execution
  return (
    <Box
      data-testid="status-bar"
      sx={{ display: "flex", alignItems: "center", gap: 2, px: 1, borderTop: 1, borderColor: "divider", minHeight: 24 }}
    >
      <Typography variant="caption">{profile == null ? "No connection" : `${profile.name} · ${profile.endpoint}`}</Typography>
      {match(portStatus)
        .with(QueryPortStatus.failed, () => (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography variant="caption" color="error" data-testid="host-failed">
              {StatusBar.HostFailedText} —
            </Typography>
            <Button size="small" color="error" onClick={() => queryPort.restart()}>
              {StatusBar.RestartLabel}
            </Button>
          </Box>
        ))
        .with(QueryPortStatus.connecting, () => <Typography variant="caption">Query host connecting…</Typography>)
        .with(QueryPortStatus.connected, () => (
          <Typography variant="caption" data-testid="host-connected">
            Query host ready
          </Typography>
        ))
        .exhaustive()}
      <Box sx={{ flex: 1 }} />
      {execution?.status === QueryExecutionStatus.success && (
        <Typography variant="caption" data-testid="status-outcome">
          {StatusBar.outcomeOf(execution)}
        </Typography>
      )}
    </Box>
  )
}

/** Status texts. */
export namespace StatusBar {
  /** Shown while the query host crash-looped. */
  export const HostFailedText = "Query host failed"
  /** Restart button label. */
  export const RestartLabel = "Restart"

  /**
   * The last outcome: rows returned, server and wall time (the shared `ResultSummary` parts).
   *
   * @param execution - The successful execution.
   * @returns `N rows · X µs server · Y ms wall`.
   */
  export function outcomeOf(execution: QueryExecutionSuccess): string {
    return ResultSummary.join([`${execution.result.page.returned_rows} rows`, ResultSummary.elapsedPart(execution)])
  }
}
