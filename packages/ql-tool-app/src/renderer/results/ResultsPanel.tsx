import { useMemo } from "react"
import Alert from "@mui/material/Alert"
import Box from "@mui/material/Box"
import LinearProgress from "@mui/material/LinearProgress"
import Tab from "@mui/material/Tab"
import Tabs from "@mui/material/Tabs"
import Typography from "@mui/material/Typography"
import { match } from "ts-pattern"

import { QueryExecutionStatus, ResultSearch } from "@wireio/ql-shared"

import { ActionRegistry, AppAction } from "../../common/index.js"
import { DisplayText } from "../common/index.js"
import { PanelErrorBoundary } from "../components/index.js"
import {
  ResultPanelKind,
  ResultsActions,
  ResultTabStatus,
  selectActiveResult,
  UiSurface,
  useAppDispatch,
  useAppSelector,
  useSurface
} from "../store/index.js"
import { ColumnChooser } from "./ColumnChooser.js"
import { FieldTypesView } from "./FieldTypesView.js"
import { FindInResults } from "./FindInResults.js"
import { FormResultView } from "./FormResultView.js"
import { JsonResultView } from "./JsonResultView.js"
import { MessagesView } from "./MessagesView.js"
import { ResultsGrid } from "./ResultsGrid.js"
import { ResultsPagerBar } from "./ResultsPagerBar.js"
import { ResultTabsBar } from "./ResultTabsBar.js"
import { ResultViews } from "./ResultViews.js"
import { StateView } from "./StateView.js"
import { StatsView } from "./StatsView.js"
import { ValueInspector } from "./ValueInspector.js"

/**
 * The bottom results area: result tabs, view tabs (Grid / Form / JSON / Field
 * Types / Stats / State / Messages), find bar, column chooser, pager bar. The
 * find hits are computed once here and shared by the find bar and the grid.
 *
 * @returns The panel.
 */
export function ResultsPanel() {
  const dispatch = useAppDispatch(),
    tab = useAppSelector(state => selectActiveResult(state.results)),
    activePanel = useAppSelector(state => state.results.activePanel),
    findOpen = useSurface(UiSurface.find),
    findText = useAppSelector(state => state.ui.findText),
    view = useMemo(() => ResultViews.of(tab), [tab?.execution, tab?.view]),
    hits = useMemo(() => (view == null || findText.length === 0 ? [] : ResultSearch.find(view, findText)), [view, findText])
  if (tab == null) {
    return (
      <Typography sx={{ p: 2 }} color="text.secondary">
        {ResultsPanel.EmptyText}
      </Typography>
    )
  }
  const execution = tab.execution,
    success = execution?.status === QueryExecutionStatus.success ? execution : null,
    failure = execution?.status === QueryExecutionStatus.failure ? execution.failure : null
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <ResultTabsBar />
      <Box sx={{ display: "flex", alignItems: "center", borderBottom: 1, borderColor: "divider" }}>
        <Tabs
          value={activePanel}
          onChange={(_event, kind: ResultPanelKind) => dispatch(ResultsActions.panelSelected(kind))}
          sx={{ flex: 1 }}
        >
          {ResultsPanel.PanelLabels.map(([kind, label]) => (
            <Tab key={kind} value={kind} label={label} data-testid={`panel-${kind}`} />
          ))}
        </Tabs>
        {findOpen && view != null && <FindInResults hits={hits} />}
        {success != null && <ColumnChooser tab={tab} columns={success.result.columns} />}
      </Box>
      {tab.status === ResultTabStatus.running && <LinearProgress />}
      {failure != null && (
        <Alert severity="error" data-testid="result-failure">
          {DisplayText.failureLine(failure)}
        </Alert>
      )}
      <Box sx={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <PanelErrorBoundary panel={activePanel}>
          {match(activePanel)
            .with(ResultPanelKind.grid, () => view != null && <ResultsGrid tab={tab} view={view} hits={hits} />)
            .with(ResultPanelKind.form, () => view != null && <FormResultView view={view} />)
            .with(ResultPanelKind.json, () => view != null && <JsonResultView view={view} />)
            .with(ResultPanelKind.fieldTypes, () => success != null && <FieldTypesView columns={success.result.columns} />)
            .with(ResultPanelKind.stats, () => success != null && <StatsView execution={success} />)
            .with(ResultPanelKind.state, () => success != null && <StateView execution={success} />)
            .with(ResultPanelKind.messages, () => <MessagesView messages={tab.messages} />)
            .exhaustive()}
        </PanelErrorBoundary>
      </Box>
      <ResultsPagerBar tab={tab} />
      {view != null && <ValueInspector view={view} />}
    </Box>
  )
}

/** Panel texts. */
export namespace ResultsPanel {
  /** Shown before the first run (the Run accelerator from the action registry). */
  export const EmptyText = `Run a query (${ActionRegistry.acceleratorText(AppAction.run)}) to see results.`

  /** Tab labels per view. */
  export const PanelLabels: ReadonlyArray<[ResultPanelKind, string]> = [
    [ResultPanelKind.grid, "Grid"],
    [ResultPanelKind.form, "Form"],
    [ResultPanelKind.json, "JSON"],
    [ResultPanelKind.fieldTypes, "Field Types"],
    [ResultPanelKind.stats, "Stats"],
    [ResultPanelKind.state, "State"],
    [ResultPanelKind.messages, "Messages"]
  ] as const
}
