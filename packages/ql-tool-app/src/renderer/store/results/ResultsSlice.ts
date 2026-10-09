import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import {
  PageSizeMode,
  QueryExecutionStatus,
  QueryPager,
  ResultSummary,
  type ColumnFilter,
  type ColumnSort,
  type PageWindow,
  type QueryExecution
} from "@wireio/ql-shared"

import { DisplayText } from "../../common/index.js"
import { findTab, nextActive } from "../common/index.js"
import { SliceName } from "../SliceName.js"

/** The result-tab views (identity enum). */
export enum ResultPanelKind {
  grid = "grid",
  form = "form",
  json = "json",
  fieldTypes = "fieldTypes",
  stats = "stats",
  state = "state",
  messages = "messages"
}

/** Lifecycle of one result tab (identity enum). */
export enum ResultTabStatus {
  idle = "idle",
  running = "running",
  succeeded = "succeeded",
  failed = "failed"
}

/** Severity of a Messages-tab line (identity enum). */
export enum MessageSeverity {
  info = "info",
  warning = "warning",
  error = "error"
}

/** One Messages-tab line (the action-output log). */
export interface ResultMessage {
  /** ISO-8601 time. */
  at: string
  /** Severity. */
  severity: MessageSeverity
  /** Text. */
  text: string
}

/** Serializable pager (the store keeps plain data; {@link Results.pagerOf} rebuilds a QueryPager). */
export interface PagerState {
  /** Paged or one unpaged request. */
  mode: PageSizeMode
  /** Rows per page. */
  pageSize: number
  /** 1-based page. */
  page: number
}

/** Client-side view over the loaded rows (labelled "this page"). */
export interface ResultViewState {
  /** Multi-sort. */
  sorts: ColumnSort[]
  /** Per-column contains-filters. */
  filters: ColumnFilter[]
  /** Columns hidden by the column chooser. */
  hiddenColumns: string[]
}

/** One result tab. */
export interface ResultTab {
  /** Stable id. */
  id: string
  /** Label. */
  title: string
  /** Pinned tabs are never replaced by the next run. */
  pinned: boolean
  /** The SQL it ran. */
  query: string
  /** Profile it ran against. */
  profileName: string
  /** Editor tab it came from (engine-error markers go there). */
  sourceEditorId: string
  /** Server paging. */
  pager: PagerState
  /** Toolbar Offset/Limit window (overrides the pager; null = pager). */
  explicitWindow: PageWindow
  /** Lifecycle. */
  status: ResultTabStatus
  /** Request in flight (or last sent). */
  requestId: string
  /** Last outcome. */
  execution: QueryExecution
  /** `state.block_id` of the page shown before this one (null = first page). */
  previousBlockId: string
  /** Client-side view. */
  view: ResultViewState
  /** Messages log (the newest {@link Results.MaxMessages}). */
  messages: ResultMessage[]
}

/** Result tabs. */
export interface ResultsState {
  /** Open result tabs. */
  tabs: ResultTab[]
  /** The focused result tab (null = none). */
  activeResultId: string
  /** The focused view. */
  activePanel: ResultPanelKind
  /** Counter behind ids and titles. */
  nextResultNumber: number
}

/** A run's target and inputs. */
export interface RunStart {
  /** The SQL. */
  query: string
  /** Profile name. */
  profileName: string
  /** Source editor tab. */
  sourceEditorId: string
  /** Toolbar Offset/Limit window (null = pager). */
  explicitWindow: PageWindow
  /** The request id of the first page. */
  requestId: string
  /** ISO-8601 now. */
  at: string
}

/** A page request on an existing result tab. */
export interface PageRequest {
  /** Result tab. */
  resultId: string
  /** New request id. */
  requestId: string
  /** New pager. */
  pager: PagerState
  /** ISO-8601 now. */
  at: string
}

/** A finished execution. */
export interface ExecutionFinish {
  /** Result tab. */
  resultId: string
  /** The request it answers (stale answers are ignored). */
  requestId: string
  /** The outcome. */
  execution: QueryExecution
  /** ISO-8601 now. */
  at: string
}

/** A partial view change on one result tab (members left out keep their value). */
export interface ViewPatch {
  /** Result tab. */
  resultId: string
  /** The members that change. */
  patch: Partial<ResultViewState>
}

/** Results constants + pure helpers. */
export namespace Results {
  /** Result tab id prefix. */
  export const ResultIdPrefix = "result-"
  /** Title prefix. */
  export const TitlePrefix = "Result"
  /** Lines a tab's Messages log keeps (older lines are dropped first). */
  export const MaxMessages = 200

  /**
   * The client view of a new result (no sorts, filters or hidden columns).
   *
   * @returns The empty view.
   */
  export function emptyView(): ResultViewState {
    return { sorts: [], filters: [], hiddenColumns: [] }
  }

  /**
   * A new running result tab for `start`, numbered `number`.
   *
   * @param number - Its sequence number (id and title).
   * @param start - The run.
   * @param message - Its first Messages line.
   * @returns The tab.
   */
  export function createTab(number: number, start: RunStart, message: ResultMessage): ResultTab {
    const { query, profileName, sourceEditorId, explicitWindow, requestId } = start
    return {
      id: `${ResultIdPrefix}${number}`,
      title: `${TitlePrefix} ${number}`,
      pinned: false,
      query,
      profileName,
      sourceEditorId,
      pager: defaultPager(),
      explicitWindow,
      status: ResultTabStatus.running,
      requestId,
      execution: null,
      previousBlockId: null,
      view: emptyView(),
      messages: [message]
    }
  }

  /**
   * Append a Messages line, keeping the newest {@link MaxMessages}.
   *
   * @param tab - The (draft) tab.
   * @param message - The line.
   */
  export function appendMessage(tab: ResultTab, message: ResultMessage): void {
    tab.messages.push(message)
    if (tab.messages.length > MaxMessages) tab.messages.splice(0, tab.messages.length - MaxMessages)
  }

  /**
   * The default pager.
   *
   * @returns Paged, default size, page 1.
   */
  export function defaultPager(): PagerState {
    return { mode: PageSizeMode.paged, pageSize: QueryPager.DefaultPageSize, page: QueryPager.FirstPage }
  }

  /**
   * Rebuild a QueryPager from plain state.
   *
   * @param pager - The state.
   * @returns The pager.
   */
  export function pagerOf(pager: PagerState): QueryPager {
    return new QueryPager({ mode: pager.mode, pageSize: pager.pageSize, page: pager.page })
  }

  /**
   * The server window a tab requests next.
   *
   * @param tab - The tab.
   * @returns The explicit window, else the pager's.
   */
  export function windowOf(tab: ResultTab): PageWindow {
    return tab.explicitWindow ?? pagerOf(tab.pager).window
  }

  /**
   * The block of the execution's page (null on failure / none).
   *
   * @param execution - The outcome.
   * @returns `state.block_id`.
   */
  export function blockIdOf(execution: QueryExecution): string {
    return execution?.status === QueryExecutionStatus.success ? execution.result.state.block_id : null
  }

  /**
   * One-line summary of an outcome for the Messages tab.
   *
   * @param execution - The outcome.
   * @returns The line.
   */
  export function describe(execution: QueryExecution): ResultMessage["text"] {
    return execution.status === QueryExecutionStatus.success
      ? ResultSummary.join([
          `${execution.result.page.returned_rows} of ${execution.result.page.total_rows} rows`,
          ResultSummary.elapsedPart(execution),
          ResultSummary.blockPart(execution.result.state)
        ])
      : DisplayText.failureLine(execution.failure)
  }
}

/**
 * The initial results state.
 *
 * @returns No tabs.
 */
export function createResultsInitialState(): ResultsState {
  return { tabs: [], activeResultId: null, activePanel: ResultPanelKind.grid, nextResultNumber: 1 }
}

/** Results slice. */
export const ResultsSlice = createSlice({
  name: SliceName.results,
  initialState: createResultsInitialState(),
  reducers: {
    /** A run starts: reuse the focused UNPINNED tab, else open a new one (page 1, pager size kept). */
    runStarted(state: ResultsState, action: PayloadAction<RunStart>) {
      const { query, profileName, sourceEditorId, explicitWindow, requestId, at } = action.payload,
        active = findTab(state.tabs, state.activeResultId),
        message: ResultMessage = { at, severity: MessageSeverity.info, text: `Running: ${query}` }
      if (active != null && !active.pinned) {
        active.query = query
        active.profileName = profileName
        active.sourceEditorId = sourceEditorId
        active.explicitWindow = explicitWindow
        active.requestId = requestId
        active.status = ResultTabStatus.running
        active.previousBlockId = null
        active.pager = { ...active.pager, page: QueryPager.FirstPage }
        active.view = Results.emptyView()
        Results.appendMessage(active, message)
        return
      }
      const number = state.nextResultNumber,
        tab = Results.createTab(number, action.payload, message)
      state.tabs.push(tab)
      state.activeResultId = tab.id
      state.nextResultNumber = number + 1
    },
    /** Another page of an existing tab is requested. */
    pageRequested(state: ResultsState, action: PayloadAction<PageRequest>) {
      const tab = findTab(state.tabs, action.payload.resultId)
      if (tab == null) return
      tab.previousBlockId = Results.blockIdOf(tab.execution)
      tab.pager = action.payload.pager
      tab.explicitWindow = null
      tab.requestId = action.payload.requestId
      tab.status = ResultTabStatus.running
      Results.appendMessage(tab, {
        at: action.payload.at,
        severity: MessageSeverity.info,
        text: `Fetching page ${action.payload.pager.page}`
      })
    },
    /** A request answered (ignored when a newer request superseded it). */
    executionFinished(state: ResultsState, action: PayloadAction<ExecutionFinish>) {
      const { resultId, requestId, execution, at } = action.payload,
        tab = findTab(state.tabs, resultId)
      if (tab == null || tab.requestId !== requestId) return
      tab.execution = execution
      tab.status =
        execution.status === QueryExecutionStatus.success ? ResultTabStatus.succeeded : ResultTabStatus.failed
      Results.appendMessage(tab, {
        at,
        severity: execution.status === QueryExecutionStatus.success ? MessageSeverity.info : MessageSeverity.error,
        text: Results.describe(execution)
      })
    },
    /** Focus a result tab. */
    resultActivated(state: ResultsState, action: PayloadAction<string>) {
      if (findTab(state.tabs, action.payload) != null) state.activeResultId = action.payload
    },
    /** Close a result tab. */
    resultClosed(state: ResultsState, action: PayloadAction<string>) {
      const index = state.tabs.findIndex(tab => tab.id === action.payload)
      if (index < 0) return
      state.tabs.splice(index, 1)
      if (state.activeResultId === action.payload) state.activeResultId = nextActive(state.tabs, index)
    },
    /** Toggle a tab's pin. */
    pinToggled(state: ResultsState, action: PayloadAction<string>) {
      const tab = findTab(state.tabs, action.payload)
      if (tab != null) tab.pinned = !tab.pinned
    },
    /** Focus a view. */
    panelSelected(state: ResultsState, action: PayloadAction<ResultPanelKind>) {
      state.activePanel = action.payload
    },
    /** Some of the sorts / filters / hidden columns changed (the rest are kept). */
    viewPatched(state: ResultsState, action: PayloadAction<ViewPatch>) {
      const tab = findTab(state.tabs, action.payload.resultId)
      if (tab != null) tab.view = { ...tab.view, ...action.payload.patch }
    }
  }
})

/** Results actions. */
export const ResultsActions = ResultsSlice.actions

/**
 * The focused result tab.
 *
 * @param state - Results state.
 * @returns The tab, or undefined.
 */
export function selectActiveResult(state: ResultsState): ResultTab {
  return findTab(state.tabs, state.activeResultId)
}
