/**
 * @jest-environment jsdom
 */
import { fireEvent, screen, waitFor } from "@testing-library/react"

import { PageSizeMode, ResultSearch, SortDirection } from "@wireio/ql-shared"

import {
  ColumnChooser,
  FindInResults,
  KeyValueTable,
  MessagesView,
  ResultsPagerBar,
  ResultTabsBar,
  ResultViews,
  ValueInspector
} from "@wireio/ql-tool-app/renderer/results"
import { MessageSeverity, ResultTabStatus, UiActions, selectActiveResult } from "@wireio/ql-tool-app/renderer/store"

import { ExecutionFixtures } from "../../common/ExecutionFixtures.js"
import { RenderWithStore } from "../../common/RenderWithStore.js"

afterEach(() => RenderWithStore.cleanup())

describe("FindInResults", () => {
  it("counts the hits it is given and walks them, moving the cursor; typing updates the find text", async () => {
    const workbench = await RenderWithStore.withResult(),
      view = ResultViews.of(selectActiveResult(workbench.store.getState().results)),
      { rerender } = RenderWithStore.render(<FindInResults hits={[]} />, workbench)
    expect(screen.getByTestId("find-count")).toHaveTextContent("0/0")
    fireEvent.change(screen.getByLabelText("Find in results"), { target: { value: "alice" } })
    expect(workbench.store.getState().ui.findText).toBe("alice")
    rerender(<FindInResults hits={ResultSearch.find(view, "alice")} />)
    expect(screen.getByTestId("find-count")).toHaveTextContent("1/1")
    fireEvent.click(screen.getByLabelText("Next hit"))
    expect(workbench.store.getState().ui.cursor).toEqual({ rowIndex: 0, column: "name" })
  })
})

describe("ColumnChooser", () => {
  it("hides a column but never the last visible one", async () => {
    const workbench = await RenderWithStore.withResult(),
      tab = () => selectActiveResult(workbench.store.getState().results),
      columns = ExecutionFixtures.success("x").result.columns
    const { rerender } = RenderWithStore.render(<ColumnChooser tab={tab()} columns={columns} />, workbench)
    fireEvent.click(screen.getByLabelText("Columns"))
    fireEvent.click(screen.getByText("amount"))
    expect(tab().view.hiddenColumns).toEqual(["amount"])
    columns
      .filter(column => column.name !== "amount")
      .forEach(column => {
        rerender(<ColumnChooser tab={tab()} columns={columns} />)
        fireEvent.click(screen.getByText(column.name))
      })
    expect(tab().view.hiddenColumns).toHaveLength(columns.length - 1)
  })
})

describe("ResultsPagerBar", () => {
  it("labels the page and disables navigation on a single page", async () => {
    const workbench = await RenderWithStore.withResult(),
      tab = selectActiveResult(workbench.store.getState().results)
    RenderWithStore.render(<ResultsPagerBar tab={tab} />, workbench)
    expect(screen.getByTestId("pager-label")).toHaveTextContent("page 1/1 · rows 1–3 of 3 · block 1000")
    expect(screen.getByLabelText("Next page")).toBeDisabled()
    expect(ResultsPagerBar.pageCount({ ...tab, pager: { mode: PageSizeMode.paged, pageSize: 1, page: 1 } })).toBe(3)
    expect(ResultsPagerBar.label({ ...tab, execution: null })).toBe("")
    expect(ResultsPagerBar.label({ ...tab, pager: { mode: PageSizeMode.all, pageSize: 1, page: 1 } })).toBe(
      "page 1/1 · rows 1–3 of 3 · block 1000"
    )
  })

  it("Next requests page 2 through the query port", async () => {
    const workbench = await RenderWithStore.withResult(),
      tab = { ...selectActiveResult(workbench.store.getState().results), pager: { mode: PageSizeMode.paged, pageSize: 1, page: 1 } }
    RenderWithStore.render(<ResultsPagerBar tab={tab} />, workbench)
    fireEvent.click(screen.getByLabelText("Next page"))
    await waitFor(() => expect(workbench.queryPort.execute).toHaveBeenCalledTimes(2))
    expect(workbench.queryPort.execute.mock.calls[1][0].window).toEqual({ offset: 1, limit: 1 })
  })
})

describe("ValueInspector / KeyValueTable / MessagesView", () => {
  it("the inspector opens on its target and closes", async () => {
    const workbench = await RenderWithStore.withResult(),
      view = ResultViews.of(selectActiveResult(workbench.store.getState().results))
    workbench.store.dispatch(UiActions.inspectorChanged({ rowIndex: 0, column: "balance" }))
    RenderWithStore.render(<ValueInspector view={view} />, workbench)
    expect(screen.getByTestId("inspector-display")).toHaveTextContent("1.5")
    fireEvent.click(screen.getByText("Close"))
    expect(workbench.store.getState().ui.inspector).toBeNull()
  })

  it("an out-of-range target keeps the inspector closed", async () => {
    const workbench = await RenderWithStore.withResult(),
      view = ResultViews.of(selectActiveResult(workbench.store.getState().results))
    workbench.store.dispatch(UiActions.inspectorChanged({ rowIndex: 99, column: "name" }))
    RenderWithStore.render(<ValueInspector view={view} />, workbench)
    expect(screen.queryByTestId("inspector-display")).toBeNull()
  })

  it("key/value rows and severity-tagged messages render", () => {
    RenderWithStore.render(
      <>
        <KeyValueTable entries={[{ label: "block", value: "1000" }]} testId="kv" />
        <MessagesView messages={[{ at: "2026-10-07T12:00:00.000Z", severity: MessageSeverity.error, text: "boom" }]} />
      </>
    )
    expect(screen.getByTestId("kv")).toHaveTextContent("block1000")
    expect(document.body).toHaveTextContent("boom")
  })
})

describe("ResultViews.optionsOf", () => {
  it("projects the tab's sorts, filters and visible columns onto a result", async () => {
    const workbench = await RenderWithStore.withResult(),
      tab = selectActiveResult(workbench.store.getState().results),
      result = ExecutionFixtures.success("x").result,
      view = { sorts: [{ column: "name", direction: SortDirection.desc }], filters: [{ column: "name", text: "a" }], hiddenColumns: ["amount"] }
    expect(ResultViews.optionsOf({ ...tab, view }, result)).toEqual({
      sorts: view.sorts,
      filters: view.filters,
      columns: ["name", "balance"]
    })
    expect(ResultViews.of({ ...tab, execution: null })).toBeNull()
  })
})

describe("ResultTabsBar.titleOf", () => {
  it("marks a running tab", async () => {
    const workbench = await RenderWithStore.withResult(),
      tab = selectActiveResult(workbench.store.getState().results)
    expect(ResultTabsBar.titleOf(tab)).toBe(tab.title)
    expect(ResultTabsBar.titleOf({ ...tab, status: ResultTabStatus.running })).toBe(`${tab.title}${ResultTabsBar.RunningSuffix}`)
  })
})
