import { PageSizeMode, QueryErrorKind, QueryFailureKind, QueryPager, SortDirection } from "@wireio/ql-shared"

import {
  initialResultsState,
  QueryRunStatus,
  ResultsActions,
  ResultsSlice,
  ResultsState,
  selectCursorColumn,
  selectCursorRow,
  selectResultJsonLines,
  selectResultView
} from "@wireio/ql-tool-cli/tui/index.js"

import { clientFailureExecution, engineFailureExecution, sampleResult, successExecution } from "../../common/engineFixtures.js"

const reduce = ResultsSlice.reducer

describe("ResultsSlice", () => {
  it("tracks a run from start to success / failure", () => {
    const running = reduce(initialResultsState, ResultsActions.runStarted("SELECT 1")),
      succeeded = reduce({ ...running, cursorRow: 2 }, ResultsActions.runFinished(successExecution())),
      failed = reduce(running, ResultsActions.runFinished(engineFailureExecution(QueryErrorKind.QUERY_SYNTAX)))
    expect(running).toMatchObject({ status: QueryRunStatus.running, query: "SELECT 1" })
    expect(succeeded).toMatchObject({ status: QueryRunStatus.succeeded, cursorRow: 0 })
    expect(failed.status).toBe(QueryRunStatus.failed)
    expect(ResultsState.success(failed)).toBeUndefined()
  })

  it("pages: pager window, explicit window, page count, page-size cycle through All", () => {
    const state = { ...initialResultsState, page: 3, pageSize: 25, execution: successExecution(sampleResult({ total: 60 })) }
    expect(ResultsState.requestWindow(state)).toEqual({ limit: 25, offset: 50 })
    expect(ResultsState.requestWindow({ ...state, window: { offset: 4, limit: 2 } })).toEqual({ offset: 4, limit: 2 })
    expect(ResultsState.pageCount(state)).toBe(3)
    expect(ResultsState.pageCount(initialResultsState)).toBe(1)
    const cycled = QueryPager.PageSizeChoices.reduce(current => reduce(current, ResultsActions.pageSizeCycled()), state)
    expect(cycled).toMatchObject({ mode: PageSizeMode.all, page: 1 })
    expect(reduce(cycled, ResultsActions.pageSizeCycled())).toMatchObject({ mode: PageSizeMode.paged, pageSize: QueryPager.PageSizeChoices[0] })
    expect(reduce(state, ResultsActions.pageSelected(0)).page).toBe(1)
    expect(reduce(state, ResultsActions.windowSet(null)).window).toBeNull()
  })

  it("sorts asc → desc → off, filters, clears, and moves/places the cursor (clamped)", () => {
    const asc = reduce(initialResultsState, ResultsActions.sortToggled("id")),
      desc = reduce(asc, ResultsActions.sortToggled("id"))
    expect(asc.sorts).toEqual([{ column: "id", direction: SortDirection.asc }])
    expect(desc.sorts).toEqual([{ column: "id", direction: SortDirection.desc }])
    expect(reduce(desc, ResultsActions.sortToggled("id")).sorts).toEqual([])
    expect(reduce(desc, ResultsActions.sortToggled("name")).sorts).toEqual([{ column: "name", direction: SortDirection.asc }])
    const filtered = reduce(initialResultsState, ResultsActions.filterSet({ column: "name", text: "a" }))
    expect(filtered.filters).toEqual([{ column: "name", text: "a" }])
    expect(reduce(filtered, ResultsActions.filterSet({ column: "name", text: "" })).filters).toEqual([])
    expect(reduce(filtered, ResultsActions.filtersCleared()).filters).toEqual([])
    const moved = reduce(initialResultsState, ResultsActions.cursorMoved({ rowDelta: 9, columnDelta: 9, rowCount: 3, columnCount: 2 }))
    expect(moved).toMatchObject({ cursorRow: 2, cursorColumn: 1 })
    expect(reduce(moved, ResultsActions.cursorPlaced(-1)).cursorRow).toBe(0)
    expect(reduce(moved, ResultsActions.findTextSet("bob")).findText).toBe("bob")
  })

  it("selectResultView builds (and memoizes) the client view; drops sorts/filters on unknown columns", () => {
    expect(selectResultView(initialResultsState)).toBeUndefined()
    const state = { ...initialResultsState, execution: successExecution(), sorts: [{ column: "id", direction: SortDirection.desc }, { column: "gone", direction: SortDirection.asc }], filters: [{ column: "gone", text: "x" }] },
      view = selectResultView(state)
    expect(view.rowCount).toBe(3)
    expect(view.row(0).id).toBe("3")
    expect(selectResultView(state)).toBe(view)
  })

  it("toggles column visibility, shows all, and resets the cursor column", () => {
    const hidden = reduce({ ...initialResultsState, cursorColumn: 1 }, ResultsActions.columnToggled("id"))
    expect(hidden).toMatchObject({ hiddenColumns: ["id"], cursorColumn: 0 })
    expect(reduce(hidden, ResultsActions.columnToggled("id")).hiddenColumns).toEqual([])
    expect(reduce(reduce(hidden, ResultsActions.columnToggled("name")), ResultsActions.columnsShown()).hiddenColumns).toEqual([])
  })

  it("projects the view onto the visible columns; a projection hiding everything falls back to all", () => {
    const { columns } = sampleResult(),
      state = { ...initialResultsState, execution: successExecution(), hiddenColumns: ["id", "gone"] }
    expect(ResultsState.visibleColumns(state, columns)).toEqual(["name"])
    expect(selectResultView(state).columns.map(column => column.name)).toEqual(["name"])
    expect(ResultsState.visibleColumns({ ...state, hiddenColumns: ["id", "name"] }, columns)).toEqual(["id", "name"])
    expect(selectResultView(initialResultsState)).toBeUndefined()
  })

  it("viewOptions drops sorts / filters naming unknown columns and carries the projection", () => {
    const state = {
      ...initialResultsState,
      sorts: [{ column: "gone", direction: SortDirection.asc }, { column: "id", direction: SortDirection.desc }],
      filters: [{ column: "gone", text: "x" }],
      hiddenColumns: ["name"]
    }
    expect(ResultsState.viewOptions(state, sampleResult().columns)).toEqual({
      sorts: [{ column: "id", direction: SortDirection.desc }],
      filters: [],
      columns: ["id"]
    })
  })

  it("Retry: engine failures follow the server flag, transport always retries, a cancel never does", () => {
    const busy = engineFailureExecution(QueryErrorKind.QUERY_BUSY, { retryable: true }),
      syntax = engineFailureExecution(QueryErrorKind.QUERY_SYNTAX),
      transport = clientFailureExecution(QueryFailureKind.transport),
      cancelled = clientFailureExecution(QueryFailureKind.cancelled),
      failedWith = (execution: typeof busy) => reduce(initialResultsState, ResultsActions.runFinished(execution))
    expect(ResultsState.isRetryable(busy.failure)).toBe(true)
    expect(ResultsState.isRetryable(syntax.failure)).toBe(false)
    expect(ResultsState.isRetryable(transport.failure)).toBe(true)
    expect(ResultsState.isRetryable(cancelled.failure)).toBe(false)
    expect(ResultsState.canRetry(failedWith(busy))).toBe(true)
    expect(ResultsState.canRetry(failedWith(syntax))).toBe(false)
    expect(ResultsState.canRetry({ ...failedWith(busy), status: QueryRunStatus.running })).toBe(false)
    expect(ResultsState.canRetry(initialResultsState)).toBe(false)
    expect(ResultsState.failure(failedWith(busy))).toBe(busy)
    expect(ResultsState.failure(reduce(initialResultsState, ResultsActions.runFinished(successExecution())))).toBeUndefined()
  })

  it("cycling the page size clears an explicit window", () => {
    const windowed = { ...initialResultsState, window: { offset: 4, limit: 2 } }
    expect(reduce(windowed, ResultsActions.pageSizeCycled()).window).toBeNull()
  })

  it("selectCursorRow / selectCursorColumn clamp the cursor to the view; undefined without one", () => {
    const state = { ...initialResultsState, execution: successExecution(), cursorRow: 9, cursorColumn: 9 }
    expect(selectCursorRow(state)).toBe(2)
    expect(selectCursorColumn(state)).toBe(1)
    expect(selectCursorRow(initialResultsState)).toBeUndefined()
    expect(selectCursorColumn(initialResultsState)).toBeUndefined()
    expect(selectCursorRow({ ...initialResultsState, execution: successExecution(sampleResult({ total: 0 })), filters: [{ column: "name", text: "nobody" }] })).toBeUndefined()
  })

  it("selectResultJsonLines renders the page as JSON lines; the JSON tab scrolls on its own (clamped), reset by a run", () => {
    const state = { ...initialResultsState, execution: successExecution() },
      lines = selectResultJsonLines(state)
    expect(lines.length).toBeGreaterThan(3)
    expect(selectResultJsonLines(initialResultsState)).toEqual([])
    const scrolled = reduce(state, ResultsActions.jsonScrolled({ delta: 99, lineCount: 10, height: 4 }))
    expect(scrolled.jsonLine).toBe(6)
    expect(scrolled.cursorRow).toBe(0)
    expect(reduce(scrolled, ResultsActions.jsonScrolled({ delta: -99, lineCount: 10, height: 4 })).jsonLine).toBe(0)
    expect(reduce(state, ResultsActions.jsonScrolled({ delta: 1, lineCount: 2, height: 4 })).jsonLine).toBe(0)
    expect(reduce(scrolled, ResultsActions.runFinished(successExecution())).jsonLine).toBe(0)
  })

  it("viewOptions takes just the view inputs", () => {
    expect(ResultsState.viewOptions({ sorts: [], filters: [], hiddenColumns: ["id"] }, sampleResult().columns)).toEqual({
      sorts: [],
      filters: [],
      columns: ["name"]
    })
  })
})
