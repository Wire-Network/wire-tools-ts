import { createSelector, createSlice, type PayloadAction } from "@reduxjs/toolkit"
import { xor } from "lodash"
import { match } from "ts-pattern"

import {
  OutputFormat,
  PageSizeMode,
  QueryExecutionStatus,
  QueryFailureKind,
  QueryPager,
  QueryRetryPolicy,
  SortDirection,
  type ColumnFilter,
  type ColumnSort,
  type PageWindow,
  type QueryColumn,
  type QueryExecution,
  type QueryExecutionFailure,
  type QueryExecutionSuccess,
  type QueryFailure,
  type ResultViewOptions,
  ResultRenderer,
  ResultView
} from "@wireio/ql-shared"

import { clampIndex, moveCursor } from "../../../utils/index.js"
import { SliceName } from "../SliceName.js"

/** Lifecycle of the current query run. */
export enum QueryRunStatus {
  idle = "idle",
  running = "running",
  succeeded = "succeeded",
  failed = "failed"
}

/** Grid cursor movement, clamped to the view's bounds. */
export interface GridCursorMove {
  /** Rows to move (negative = up). */
  rowDelta: number
  /** Columns to move (negative = left). */
  columnDelta: number
  /** Rows in the view. */
  rowCount: number
  /** Columns in the view. */
  columnCount: number
}

/** A JSON-tab scroll: the line delta and the extent it is clamped to. */
export interface JsonScroll {
  /** Lines to scroll (negative = up). */
  delta: number
  /** Rendered JSON lines. */
  lineCount: number
  /** Visible lines (the last top line keeps the final line on screen). */
  height: number
}

/** One page-size choice (the cycle of `z`). */
export interface PageSizeChoice {
  /** Paged or all. */
  mode: PageSizeMode
  /** Rows per page. */
  pageSize: number
}

/** The client view's inputs over the loaded page (sort, filter, projection). */
export interface ResultsViewState {
  /** Client sorts over the loaded page. */
  sorts: ColumnSort[]
  /** Client filters over the loaded page. */
  filters: ColumnFilter[]
  /** Columns hidden from the grid / record / JSON views and page exports (client projection). */
  hiddenColumns: string[]
}

/** The current run, its server window, and the client view over the loaded page. */
export interface ResultsState extends ResultsViewState {
  /** Run lifecycle. */
  status: QueryRunStatus
  /** SQL of the last run (paging re-sends it, not the editor text). */
  query: string
  /** Last outcome (null before the first run). */
  execution: QueryExecution
  /** Rows per server page. */
  pageSize: number
  /** 1-based server page. */
  page: number
  /** Paged or all. */
  mode: PageSizeMode
  /** Explicit offset/limit window (null = the pager decides). */
  window: PageWindow
  /** Grid cursor row (view index). */
  cursorRow: number
  /** Grid cursor column (view column index). */
  cursorColumn: number
  /** Find-in-results text. */
  findText: string
  /** Top line of the JSON tab (its own scroll, independent of the grid cursor). */
  jsonLine: number
}

/** The initial results state. */
export const initialResultsState: ResultsState = {
  status: QueryRunStatus.idle,
  query: "",
  execution: null,
  pageSize: QueryPager.DefaultPageSize,
  page: QueryPager.FirstPage,
  mode: PageSizeMode.paged,
  window: null,
  sorts: [],
  filters: [],
  hiddenColumns: [],
  cursorRow: 0,
  cursorColumn: 0,
  findText: "",
  jsonLine: 0
}

/** Results derivations (pure). */
export namespace ResultsState {
  /**
   * The pager of the state.
   *
   * @param state - Results state.
   * @returns The pager.
   */
  export function pager(state: ResultsState): QueryPager {
    return new QueryPager({ mode: state.mode, pageSize: state.pageSize, page: state.page })
  }

  /**
   * The server window to request: the explicit window, else the pager's.
   *
   * @param state - Results state.
   * @returns The window.
   */
  export function requestWindow(state: ResultsState): PageWindow {
    return state.window ?? pager(state).window
  }

  /**
   * The successful execution, or undefined.
   *
   * @param state - Results state.
   * @returns The success outcome.
   */
  export function success(state: ResultsState): QueryExecutionSuccess {
    return state.execution?.status === QueryExecutionStatus.success ? state.execution : undefined
  }

  /**
   * The failed execution, or undefined.
   *
   * @param state - Results state.
   * @returns The failure outcome.
   */
  export function failure(state: ResultsState): QueryExecutionFailure {
    return state.execution?.status === QueryExecutionStatus.failure ? state.execution : undefined
  }

  /**
   * Whether a failure may be retried: an engine failure follows the server's
   * flag through {@link QueryRetryPolicy.canRetry}; a transport failure (node
   * unreachable, timeout, bad envelope) can always be re-sent; a user cancel is
   * re-run with Run, not Retry.
   *
   * @param failed - The failure.
   * @returns Whether Retry is offered.
   */
  export function isRetryable(failed: QueryFailure): boolean {
    return match(failed.kind)
      .with(QueryFailureKind.engine, () => QueryRetryPolicy.canRetry(failed.data))
      .with(QueryFailureKind.transport, () => true)
      .with(QueryFailureKind.cancelled, () => false)
      .exhaustive()
  }

  /**
   * Whether Retry applies now: the last run failed retryably and nothing is running.
   *
   * @param state - Results state.
   * @returns Whether Retry is enabled.
   */
  export function canRetry(state: ResultsState): boolean {
    const failed = failure(state)
    return state.status === QueryRunStatus.failed && failed != null && isRetryable(failed.failure)
  }

  /**
   * The visible columns of a result: every column not hidden, in result order
   * — or every column when the projection would hide them all (a hidden set
   * left over from another query never blanks the grid).
   *
   * @param state - The view inputs (a results state).
   * @param columns - The result's columns.
   * @returns The visible column names.
   */
  export function visibleColumns(state: ResultsViewState, columns: QueryColumn[]): string[] {
    const names = columns.map(column => column.name),
      visible = names.filter(name => !state.hiddenColumns.includes(name))
    return visible.length === 0 ? names : visible
  }

  /**
   * The client view options over a result: sorts / filters naming a column the
   * result lacks (a new query) are dropped rather than failing, and the
   * projection is {@link visibleColumns}.
   *
   * @param state - The view inputs (a results state).
   * @param columns - The result's columns.
   * @returns The view options.
   */
  export function viewOptions(state: ResultsViewState, columns: QueryColumn[]): ResultViewOptions {
    const known = new Set(columns.map(column => column.name))
    return {
      sorts: state.sorts.filter(sort => known.has(sort.column)),
      filters: state.filters.filter(filter => known.has(filter.column)),
      columns: visibleColumns(state, columns)
    }
  }

  /**
   * Page count of the last success (1 when unknown).
   *
   * @param state - Results state.
   * @returns The page count.
   */
  export function pageCount(state: ResultsState): number {
    const executed = success(state)
    return executed == null || state.mode === PageSizeMode.all || state.window != null
      ? QueryPager.FirstPage
      : QueryPager.pageCount(executed.result.page, state.pageSize)
  }

  /**
   * The next page-size choice: through {@link QueryPager.PageSizeChoices}, then All, then back.
   *
   * @param state - Results state.
   * @returns The next mode + size.
   */
  export function nextPageSize(state: ResultsState): PageSizeChoice {
    const choices = QueryPager.PageSizeChoices,
      index = choices.indexOf(state.pageSize)
    return match(state)
      .with({ mode: PageSizeMode.all }, (): PageSizeChoice => ({ mode: PageSizeMode.paged, pageSize: choices[0] }))
      .when(() => index === choices.length - 1, (): PageSizeChoice => ({ mode: PageSizeMode.all, pageSize: state.pageSize }))
      .otherwise((): PageSizeChoice => ({ mode: PageSizeMode.paged, pageSize: choices[index + 1] ?? choices[0] }))
  }
}

/**
 * The client view over the loaded page (memoized on execution / sorts /
 * filters / hidden columns), built from {@link ResultsState.viewOptions}.
 *
 * @returns The view, or undefined before the first success.
 */
export const selectResultView = createSelector(
  [
    (state: ResultsState) => ResultsState.success(state),
    (state: ResultsState) => state.sorts,
    (state: ResultsState) => state.filters,
    (state: ResultsState) => state.hiddenColumns
  ],
  (execution, sorts, filters, hiddenColumns): ResultView =>
    execution == null
      ? undefined
      : ResultView.create(execution.result, ResultsState.viewOptions({ sorts, filters, hiddenColumns }, execution.result.columns))
)

/**
 * The grid cursor row clamped to the view — what copy, the record view and the
 * inspector act on.
 *
 * @returns The view index, or undefined without rows.
 */
export const selectCursorRow = createSelector(
  [(state: ResultsState) => state.cursorRow, selectResultView],
  (cursorRow, view): number => (view == null || view.rowCount === 0 ? undefined : clampIndex(cursorRow, view.rowCount))
)

/**
 * The grid cursor column clamped to the view.
 *
 * @returns The view column index, or undefined without columns.
 */
export const selectCursorColumn = createSelector(
  [(state: ResultsState) => state.cursorColumn, selectResultView],
  (cursorColumn, view): number =>
    view == null || view.columns.length === 0 ? undefined : clampIndex(cursorColumn, view.columns.length)
)

/** Line separator of rendered JSON. */
const JsonLinePattern = /\n/

/**
 * The loaded page as pretty JSON lines (the same renderer as `wql --format json`),
 * memoized on the view.
 *
 * @returns The lines (empty before the first success).
 */
export const selectResultJsonLines = createSelector(
  [(state: ResultsState) => ResultsState.success(state), selectResultView],
  (execution, view): string[] =>
    view == null ? [] : ResultRenderer.render(OutputFormat.json, { execution, view, range: view.fullRange() }).split(JsonLinePattern)
)

/** Results slice. */
export const ResultsSlice = createSlice({
  name: SliceName.results,
  initialState: initialResultsState,
  reducers: {
    /** A run started. */
    runStarted(state: ResultsState, action: PayloadAction<string>) {
      state.status = QueryRunStatus.running
      state.query = action.payload
    },
    /** A run finished (success or failure); the cursor returns to the first row. */
    runFinished(state: ResultsState, action: PayloadAction<QueryExecution>) {
      state.execution = action.payload
      state.status =
        action.payload.status === QueryExecutionStatus.success ? QueryRunStatus.succeeded : QueryRunStatus.failed
      state.cursorRow = 0
      state.jsonLine = 0
    },
    /** Select a server page. */
    pageSelected(state: ResultsState, action: PayloadAction<number>) {
      state.page = Math.max(QueryPager.FirstPage, action.payload)
    },
    /** Cycle the page size (choices, then All); back to page 1, any explicit window cleared (the size decides again). */
    pageSizeCycled(state: ResultsState) {
      Object.assign(state, ResultsState.nextPageSize(state), { page: QueryPager.FirstPage, window: null })
    },
    /** Set (or clear with null) an explicit offset/limit window. */
    windowSet(state: ResultsState, action: PayloadAction<PageWindow>) {
      state.window = action.payload
    },
    /** Sort by a column: asc → desc → off (a different column starts asc). */
    sortToggled(state: ResultsState, action: PayloadAction<string>) {
      const column = action.payload
      state.sorts = match(state.sorts[0])
        .with({ column, direction: SortDirection.asc }, () => [{ column, direction: SortDirection.desc }])
        .with({ column }, () => [])
        .otherwise(() => [{ column, direction: SortDirection.asc }])
    },
    /** Set a column filter; empty text removes it. */
    filterSet(state: ResultsState, action: PayloadAction<ColumnFilter>) {
      const others = state.filters.filter(filter => filter.column !== action.payload.column)
      state.filters = action.payload.text.length === 0 ? others : [...others, action.payload]
      state.cursorRow = 0
    },
    /** Remove every filter. */
    filtersCleared(state: ResultsState) {
      state.filters = []
    },
    /** Show a hidden column, or hide a shown one; the grid cursor returns to the first column. */
    columnToggled(state: ResultsState, action: PayloadAction<string>) {
      state.hiddenColumns = xor(state.hiddenColumns, [action.payload])
      state.cursorColumn = 0
    },
    /** Show every column again. */
    columnsShown(state: ResultsState) {
      state.hiddenColumns = []
    },
    /** Move the grid cursor (clamped). */
    cursorMoved(state: ResultsState, action: PayloadAction<GridCursorMove>) {
      const { rowDelta, columnDelta, rowCount, columnCount } = action.payload
      state.cursorRow = moveCursor(state.cursorRow, rowDelta, rowCount)
      state.cursorColumn = moveCursor(state.cursorColumn, columnDelta, columnCount)
    },
    /** Place the grid cursor on a row (find hits). */
    cursorPlaced(state: ResultsState, action: PayloadAction<number>) {
      state.cursorRow = Math.max(0, action.payload)
    },
    /** Scroll the JSON tab (clamped so the last line stays on screen). */
    jsonScrolled(state: ResultsState, action: PayloadAction<JsonScroll>) {
      const { delta, lineCount, height } = action.payload
      state.jsonLine = moveCursor(state.jsonLine, delta, lineCount - height + 1)
    },
    /** Set the find text. */
    findTextSet(state: ResultsState, action: PayloadAction<string>) {
      state.findText = action.payload
    }
  }
})

/** Results actions. */
export const ResultsActions = ResultsSlice.actions
