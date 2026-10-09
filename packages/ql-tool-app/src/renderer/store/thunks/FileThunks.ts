import {
  OutputFormat,
  PageSizeMode,
  QueryExecutionStatus,
  QueryFailureError,
  ResultRenderer,
  ResultView,
  type ConnectionProfile,
  type QueryExecutionSuccess
} from "@wireio/ql-shared"

import { DialogOutcome, IPCChannel } from "../../../common/index.js"
import { ResultViews } from "../../results/ResultViews.js"
import { selectProfileNamed } from "../connections/ConnectionsSlice.js"
import { selectActiveResult, type ResultTab } from "../results/ResultsSlice.js"
import type { AppThunk, WorkbenchServices } from "../Store.js"
import { UiActions } from "../ui/UiSlice.js"
import { selectActiveEditorTab, Workspace, WorkspaceActions } from "../workspace/WorkspaceSlice.js"
import { guarded } from "./common/index.js"
import { QueryRun } from "./QueryThunks.js"

/** What an export covers (identity enum). */
export enum ExportScope {
  /** The rows of the current server page (client view applied). */
  page = "page",
  /** ONE unpaged request (one snapshot, capped by query-max-result-rows). */
  all = "all"
}

/** Export dialog choices. */
export interface ExportOptions {
  /** Output format. */
  format: OutputFormat
  /** Page or all. */
  scope: ExportScope
  /** Include the header row. */
  header: boolean
}

/** File constants. */
export namespace QueryFiles {
  /** SQL file extension (no dot). */
  export const SqlExtension = "sql"
  /** Default name of a new SQL file. */
  export const DefaultSqlName = "query.sql"
  /** Default export base name. */
  export const DefaultExportBaseName = "results"
  /** What a failed open reports. */
  export const OpenLabel = "Opening the SQL file"
  /** What a failed save reports. */
  export const SaveLabel = "Saving the SQL file"
  /** What a failed export reports. */
  export const ExportLabel = "Export"
}

/**
 * Open a `.sql` file into a new editor tab.
 *
 * @returns The thunk.
 */
export function openQueryFile(): AppThunk {
  return guarded(QueryFiles.OpenLabel, async (dispatch, _getState, services) => {
    const result = await services.bridge.invoke(IPCChannel.showOpenDialog, {
      title: "Open SQL File",
      extensions: [QueryFiles.SqlExtension]
    })
    if (result.outcome === DialogOutcome.cancelled) return
    const text = await services.bridge.invoke(IPCChannel.readQueryFile, { filePath: result.filePath })
    dispatch(
      WorkspaceActions.tabAdded({ text, filePath: result.filePath, title: Workspace.baseName(result.filePath) })
    )
  })
}

/**
 * Save the focused editor to its file (or a chosen one).
 *
 * @returns The thunk.
 */
export function saveQueryFile(): AppThunk {
  return guarded(QueryFiles.SaveLabel, async (dispatch, getState, services) => {
    const tab = selectActiveEditorTab(getState().workspace),
      { filePath: associatedPath } = tab,
      filePath =
        associatedPath ??
        (await chooseSavePath(services, "Save SQL File", QueryFiles.DefaultSqlName, [QueryFiles.SqlExtension]))
    if (filePath == null) return
    await services.bridge.invoke(IPCChannel.writeQueryFile, { filePath, text: tab.text })
    dispatch(WorkspaceActions.fileAssociated({ id: tab.id, filePath }))
  })
}

/**
 * Native save dialog → chosen path (undefined when cancelled).
 *
 * @param services - Thunk services.
 * @param title - Dialog title.
 * @param defaultName - Suggested file name.
 * @param extensions - Accepted extensions.
 * @returns The path, or undefined.
 */
async function chooseSavePath(
  services: WorkbenchServices,
  title: string,
  defaultName: string,
  extensions: string[]
): Promise<string> {
  const result = await services.bridge.invoke(IPCChannel.showSaveDialog, { title, defaultName, extensions })
  return result.outcome === DialogOutcome.selected ? result.filePath : undefined
}

/**
 * The execution an export renders: the loaded page, or ONE unpaged request
 * (recorded in history like every other request the user initiates).
 *
 * @param tab - The result tab.
 * @param scope - Page or all.
 * @param services - Thunk services.
 * @param profile - The connection.
 * @returns The thunk resolving to the successful execution.
 * @throws QueryFailureError carrying the failure when the unpaged request fails.
 */
function exportExecution(
  tab: ResultTab,
  scope: ExportScope,
  services: WorkbenchServices,
  profile: ConnectionProfile
): AppThunk<QueryExecutionSuccess> {
  return async dispatch => {
    if (scope === ExportScope.page) return tab.execution as QueryExecutionSuccess
    const execution = await QueryRun.executeOrFail(services, {
      requestId: services.createRequestId(),
      profile,
      query: tab.query,
      window: { offset: 0, limit: null },
      mode: PageSizeMode.all
    })
    await dispatch(QueryRun.recordHistory(execution, profile))
    if (execution.status === QueryExecutionStatus.failure) {
      throw new QueryFailureError(execution.failure.message, { failure: execution.failure })
    }
    return execution
  }
}

/**
 * Render the focused result (ResultRenderer, browser-safe) and write it to a
 * file chosen in the native save dialog (main only writes).
 *
 * @param options - Format, scope, header.
 * @returns The thunk.
 */
export function exportResults(options: ExportOptions): AppThunk {
  return guarded(QueryFiles.ExportLabel, async (dispatch, getState, services) => {
    const state = getState(),
      tab = selectActiveResult(state.results),
      profile = tab == null ? undefined : selectProfileNamed(state.connections, tab.profileName)
    if (tab?.execution?.status !== QueryExecutionStatus.success || profile == null) return
    const extension = ResultRenderer.fileExtension(options.format),
      filePath = await chooseSavePath(
        services,
        "Export Results",
        `${QueryFiles.DefaultExportBaseName}.${extension}`,
        [extension]
      )
    if (filePath == null) return
    const execution = await dispatch(exportExecution(tab, options.scope, services, profile)),
      view = ResultView.create(execution.result, ResultViews.optionsOf(tab, execution.result)),
      contents = ResultRenderer.render(options.format, { execution, view, range: view.fullRange() }, { header: options.header })
    await services.bridge.invoke(IPCChannel.exportWrite, { filePath, contents })
    dispatch(UiActions.noticeChanged(`Exported ${view.rowCount} rows to ${filePath}`))
  })
}
