import {
  QueryExecutionStatus,
  QueryFailure,
  QueryFormatter,
  QueryHistoryEntry,
  type ConnectionProfile,
  type QueryExecution
} from "@wireio/ql-shared"
import { getLogger, NestedError } from "@wireio/shared"

import { IPCChannel } from "../../../common/index.js"
import type { QueryExecuteParams } from "../../query/index.js"
import { selectActiveProfile, selectProfileNamed } from "../connections/ConnectionsSlice.js"
import { Results, ResultsActions, selectActiveResult, type PagerState } from "../results/ResultsSlice.js"
import type { AppThunk, WorkbenchServices } from "../Store.js"
import { Ui, UiActions, UiSurface } from "../ui/UiSlice.js"
import { selectActiveEditorTab, Workspace, WorkspaceActions, type EditorTabSeed } from "../workspace/WorkspaceSlice.js"
import { guarded, GuardedReport } from "./common/index.js"
import { loadHistory } from "./PersistenceThunks.js"

const log = getLogger(__filename)

/**
 * Query execution helpers. History: every `query.execute` request the user
 * initiates — a run, a retry, a page fetch, an export of all rows — records
 * exactly ONE history entry, as each `wql` invocation (one request) does.
 */
export namespace QueryRun {
  /** What a failed Format reports. */
  export const FormatLabel = "Formatting the query"

  /**
   * A failure outcome for a call that never produced one (the port was lost,
   * the host failed, the call was cancelled before it was sent).
   *
   * @param requestId - The request.
   * @param query - The SQL.
   * @param error - What was thrown.
   * @returns The failure execution (its failure classified by `QueryFailure.of`).
   */
  export function portFailure(requestId: string, query: string, error: unknown): QueryExecution {
    return {
      status: QueryExecutionStatus.failure,
      requestId,
      query,
      wallTimeMs: 0,
      attempts: 0,
      failure: QueryFailure.of(error)
    }
  }

  /**
   * Execute one request through the query port; a call that throws (lost port,
   * failed host) becomes a failure outcome, never a throw.
   *
   * @param services - Thunk services.
   * @param params - Request id, profile, SQL, window and mode.
   * @returns The outcome.
   */
  export async function executeOrFail(services: WorkbenchServices, params: QueryExecuteParams): Promise<QueryExecution> {
    try {
      return await services.queryPort.execute(params)
    } catch (error) {
      log.warn(`[${params.requestId}] query failed on the port: ${NestedError.toError(error).message}`, error)
      return portFailure(params.requestId, params.query, error)
    }
  }

  /**
   * Append the history entry of one request and reload the drawer (a failed
   * append is logged, never shown).
   *
   * @param execution - The outcome.
   * @param profile - The connection it ran against.
   * @returns The thunk.
   */
  export function recordHistory(execution: QueryExecution, profile: ConnectionProfile): AppThunk {
    return guarded(
      "Recording history",
      async (dispatch, _getState, services) => {
        await services.bridge.invoke(IPCChannel.historyAppend, QueryHistoryEntry.of(execution, profile.name, services.clock()))
        await dispatch(loadHistory())
      },
      GuardedReport.logOnly
    )
  }
}

/**
 * Execute the result tab's current window, store the outcome and record it in history.
 *
 * @param resultId - The result tab (its request id, query, pager and window were just set).
 * @param profile - The connection.
 * @returns The thunk.
 */
function executeResultWindow(resultId: string, profile: ConnectionProfile): AppThunk {
  return async (dispatch, getState, services) => {
    const tab = getState().results.tabs.find(candidate => candidate.id === resultId),
      { requestId, query, pager } = tab,
      execution = await QueryRun.executeOrFail(services, {
        requestId,
        profile,
        query,
        window: Results.windowOf(tab),
        mode: pager.mode
      })
    dispatch(ResultsActions.executionFinished({ resultId, requestId, execution, at: services.clock().toISOString() }))
    await dispatch(QueryRun.recordHistory(execution, profile))
  }
}

/**
 * Run the focused editor's SQL (or its selection) in a result tab: the focused
 * unpinned tab is reused, a pinned one is kept and a new tab opens.
 *
 * @param selectionOnly - Run only the selection.
 * @returns The thunk.
 */
export function runQuery(selectionOnly: boolean): AppThunk {
  return async (dispatch, getState, services) => {
    const state = getState(),
      profile = selectActiveProfile(state.connections),
      editor = selectActiveEditorTab(state.workspace)
    if (profile == null) {
      dispatch(UiActions.surfaceOpened(UiSurface.connections))
      return
    }
    const query = Workspace.queryText(editor, selectionOnly)
    if (query.length === 0) return
    dispatch(
      ResultsActions.runStarted({
        query,
        profileName: profile.name,
        sourceEditorId: editor.id,
        explicitWindow: Ui.explicitWindowOf(state.ui.windowFields),
        requestId: services.createRequestId(),
        at: services.clock().toISOString()
      })
    )
    await dispatch(executeResultWindow(getState().results.activeResultId, profile))
  }
}

/**
 * Re-run a stored query (a history entry, a saved query, the navigator's
 * Select Rows): open it in a new editor tab, then run that tab through {@link runQuery}.
 *
 * @param seed - The new tab's SQL (and title).
 * @returns The thunk.
 */
export function openAndRunQuery(seed: EditorTabSeed): AppThunk {
  return async dispatch => {
    dispatch(WorkspaceActions.tabAdded(seed))
    await dispatch(runQuery(false))
  }
}

/**
 * Fetch another server page of the focused result (page size / mode included).
 *
 * @param pager - The new pager.
 * @returns The thunk.
 */
export function fetchPage(pager: PagerState): AppThunk {
  return async (dispatch, getState, services) => {
    const state = getState(),
      tab = selectActiveResult(state.results),
      profile = tab == null ? undefined : selectProfileNamed(state.connections, tab.profileName)
    if (tab == null || profile == null) return
    dispatch(
      ResultsActions.pageRequested({
        resultId: tab.id,
        requestId: services.createRequestId(),
        pager,
        at: services.clock().toISOString()
      })
    )
    await dispatch(executeResultWindow(tab.id, profile))
  }
}

/**
 * Re-run the focused result's current window (Retry).
 *
 * @returns The thunk.
 */
export function retryQuery(): AppThunk {
  return async (dispatch, getState) => {
    const tab = selectActiveResult(getState().results)
    if (tab != null) await dispatch(fetchPage(tab.pager))
  }
}

/**
 * Abandon the focused result's running request (Stop; the server keeps working).
 *
 * @returns The thunk.
 */
export function stopQuery(): AppThunk {
  return async (_dispatch, getState, services) => {
    const tab = selectActiveResult(getState().results)
    if (tab?.requestId != null) services.queryPort.cancel(tab.requestId)
  }
}

/**
 * Beautify the focused editor's SQL with the parse-tree formatter (an
 * unparsable buffer leaves the text alone and the notice shows the parse error).
 *
 * @returns The thunk.
 */
export function formatQuery(): AppThunk {
  return guarded(QueryRun.FormatLabel, async (dispatch, getState) => {
    const tab = selectActiveEditorTab(getState().workspace)
    dispatch(WorkspaceActions.textChanged({ id: tab.id, text: QueryFormatter.format(tab.text) }))
  })
}
