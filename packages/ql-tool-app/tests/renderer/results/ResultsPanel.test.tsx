/**
 * @jest-environment jsdom
 */
import { act, fireEvent, screen, within } from "@testing-library/react"

import { QueryFailureKind, ResultSearch } from "@wireio/ql-shared"

import { ActionRegistry, AppAction } from "@wireio/ql-tool-app/common"
import { ResultPanelKind, ResultsActions, UiActions, UiSurface } from "@wireio/ql-tool-app/renderer/store"
import { ResultsPanel } from "@wireio/ql-tool-app/renderer/results"

import { ExecutionFixtures } from "../../common/ExecutionFixtures.js"
import { RenderWithStore } from "../../common/RenderWithStore.js"

afterEach(() => RenderWithStore.cleanup())

describe("ResultsPanel", () => {
  it("prompts to run a query when there is no result, naming the registry's Run accelerator", () => {
    RenderWithStore.render(<ResultsPanel />)
    expect(screen.getByText(ResultsPanel.EmptyText)).toBeInTheDocument()
    expect(ResultsPanel.EmptyText).toContain(ActionRegistry.acceleratorText(AppAction.run))
  })

  it("the find bar and the grid share ONE hit list computed by the panel", async () => {
    const workbench = await RenderWithStore.withResult()
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.find))
    workbench.store.dispatch(UiActions.findTextChanged("bob"))
    const find = jest.spyOn(ResultSearch, "find")
    RenderWithStore.render(<ResultsPanel />, workbench)
    expect(screen.getByTestId("find-count")).toHaveTextContent("1/1")
    expect(find).toHaveBeenCalledTimes(1)
    find.mockRestore()
  })

  it("renders the grid, then every other view tab of a success", async () => {
    const workbench = await RenderWithStore.withResult()
    RenderWithStore.render(<ResultsPanel />, workbench)
    expect(screen.getByTestId("results-grid")).toHaveTextContent("alice")
    expect(screen.getByTestId("pager-label")).toHaveTextContent("page 1/1 · rows 1–3 of 3 · block 1000")
    const expectations: Array<[ResultPanelKind, string]> = [
      [ResultPanelKind.json, "\"alice\""],
      [ResultPanelKind.form, "alice"],
      [ResultPanelKind.fieldTypes, "amount"],
      [ResultPanelKind.stats, "1200"],
      [ResultPanelKind.state, "1000"],
      [ResultPanelKind.messages, "Running:"]
    ]
    expectations.forEach(([kind, text]) => {
      fireEvent.click(screen.getByTestId(`panel-${kind}`))
      expect(document.body).toHaveTextContent(text)
    })
  })

  it("shows the failure alert of a failed run", async () => {
    const workbench = await RenderWithStore.withResult(requestId =>
      ExecutionFixtures.failure(requestId, QueryFailureKind.engine)
    )
    RenderWithStore.render(<ResultsPanel />, workbench)
    expect(screen.getByTestId("result-failure")).toHaveTextContent("QUERY_SYNTAX: JOIN is not supported")
  })

  it("result tabs pin and close", async () => {
    const workbench = await RenderWithStore.withResult()
    RenderWithStore.render(<ResultsPanel />, workbench)
    const tab = screen.getByTestId("result-tab-result-1")
    fireEvent.click(within(tab).getByLabelText("Pin Result 1"))
    expect(workbench.store.getState().results.tabs[0].pinned).toBe(true)
    fireEvent.click(within(tab).getByLabelText("Close Result 1"))
    expect(workbench.store.getState().results.tabs).toEqual([])
  })

  it("a large result is virtualized (only a window of rows is in the DOM)", async () => {
    const workbench = await RenderWithStore.withResult(requestId =>
      ExecutionFixtures.success(requestId, ExecutionFixtures.bigTable())
    )
    RenderWithStore.render(<ResultsPanel />, workbench)
    const bodyRows = screen.getByTestId("results-grid").querySelectorAll("tbody tr[data-index]")
    expect(bodyRows.length).toBeLessThan(100)
    act(() => {
      workbench.store.dispatch(ResultsActions.panelSelected(ResultPanelKind.grid))
    })
  })
})
