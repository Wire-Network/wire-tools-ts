import { act } from "react"

import { PageSizeMode, QueryErrorKind } from "@wireio/ql-shared"

import {
  createTuiStore,
  FocusArea,
  ResultsActions,
  ResultsTab,
  ResultsTabs,
  StatusBar,
  UiActions,
  initialResultsState,
  QueryRunStatus,
  SchemaTreePanel
} from "@wireio/ql-tool-cli/tui/index.js"

import { engineFailureExecution, successExecution } from "../../common/engineFixtures.js"
import { renderTui, textOf } from "../../common/renderTui.js"
import { storeWithResult } from "../../common/storeFixtures.js"

describe("ResultsTabs", () => {
  it("renders the tab strip and the active tab", () => {
    const store = storeWithResult()
    store.dispatch(UiActions.tabSelected(ResultsTab.record))
    const text = textOf(renderTui(<ResultsTabs focused height={5} width={80} />, { store }))
    expect(text).toContain(" Grid \n JSON \n Record ")
    expect(text).toContain("record 1 of 3")
    expect(ResultsTabs.Tabs.map(tab => tab.key)).toEqual(Object.values(ResultsTab))
  })

  it("shows a failed run's error on every tab but Messages", () => {
    const store = storeWithResult(engineFailureExecution(QueryErrorKind.QUERY_SYNTAX))
    expect(textOf(renderTui(<ResultsTabs focused height={5} width={80} />, { store }))).toContain("error: QUERY_SYNTAX: boom")
    act(() => void store.dispatch(UiActions.tabSelected(ResultsTab.messages)))
    expect(textOf(renderTui(<ResultsTabs focused height={5} width={80} />, { store }))).not.toContain("error: QUERY_SYNTAX")
  })
})

describe("StatusBar", () => {
  it("describes each run state and the paging", () => {
    expect(StatusBar.statusText(initialResultsState)).toBe("ready")
    expect(StatusBar.statusText({ ...initialResultsState, status: QueryRunStatus.running })).toBe("running… · page 1/1 (size 100)")
    expect(StatusBar.statusText({ ...initialResultsState, status: QueryRunStatus.failed })).toBe("failed · see Messages")
    expect(
      StatusBar.statusText({
        ...initialResultsState,
        status: QueryRunStatus.failed,
        execution: engineFailureExecution(QueryErrorKind.QUERY_BUSY, { retryable: true })
      })
    ).toBe(`failed · ${StatusBar.RetryableText} · see Messages`)
    expect(
      StatusBar.statusText({ ...initialResultsState, status: QueryRunStatus.failed, execution: engineFailureExecution(QueryErrorKind.QUERY_SYNTAX) })
    ).toBe("failed · see Messages")
    expect(StatusBar.hintsFor(FocusArea.grid)).toContain("c columns")
    expect(StatusBar.statusText({ ...initialResultsState, status: QueryRunStatus.succeeded, execution: successExecution() })).toBe(
      "page 1/1 (size 100) · rows 1–3 of 3 · block 42 · 900 µs server · 12.5 ms wall"
    )
    expect(StatusBar.statusText({ ...initialResultsState, window: { offset: 4, limit: null } })).toBe("ready")
    const store = createTuiStore()
    store.dispatch(ResultsActions.windowSet({ offset: 4, limit: null }))
    store.dispatch(ResultsActions.runStarted("q"))
    expect(textOf(renderTui(<StatusBar />, { store }))).toContain("window offset 4 limit none")
  })

  it("shows the hints of the focused area", () => {
    Object.values(FocusArea).forEach(focus => expect(StatusBar.hintsFor(focus).length).toBeGreaterThan(0))
    const store = createTuiStore()
    store.dispatch(UiActions.focusSet(FocusArea.grid))
    store.dispatch(ResultsActions.pageSizeCycled())
    store.dispatch(ResultsActions.pageSizeCycled())
    store.dispatch(ResultsActions.pageSizeCycled())
    store.dispatch(ResultsActions.runStarted("q"))
    expect(textOf(renderTui(<StatusBar />, { store }))).toContain(`page All\n${StatusBar.hintsFor(FocusArea.grid)}`)
  })
})

describe("StatusBar paging and schema hints", () => {
  it("pagingText: an explicit window first, then All, then page N/M", () => {
    const base = createTuiStore().getState().results
    expect(StatusBar.pagingText({ ...base, window: { offset: 5, limit: null } })).toBe("window offset 5 limit none")
    expect(StatusBar.pagingText({ ...base, window: { offset: 5, limit: 7 } })).toBe("window offset 5 limit 7")
    expect(StatusBar.pagingText({ ...base, mode: PageSizeMode.all })).toBe(StatusBar.AllPagesText)
    expect(StatusBar.pagingText(base)).toMatch(/^page 1\/\d+ \(size \d+\)$/)
  })

  it("shows the schema tree's own hint when the tree is focused", () => {
    expect(StatusBar.hintsFor(FocusArea.schema)).toBe(SchemaTreePanel.KeysHint)
  })
})
