/**
 * @jest-environment jsdom
 */
import { fireEvent, screen, waitFor } from "@testing-library/react"

import { SortDirection } from "@wireio/ql-shared"

import { AppAction, ContextMenuItems, IPCChannel } from "@wireio/ql-tool-app/common"
import { ResultsGrid, ResultViews } from "@wireio/ql-tool-app/renderer/results"
import { selectActiveResult } from "@wireio/ql-tool-app/renderer/store"

import { RenderWithStore } from "../../common/RenderWithStore.js"
import type { FakeWorkbench } from "../../common/FakeWorkbench.js"

/** Render the grid of the focused result. */
function renderGrid(workbench: FakeWorkbench): void {
  const tab = selectActiveResult(workbench.store.getState().results)
  RenderWithStore.render(<ResultsGrid tab={tab} view={ResultViews.of(tab)} hits={[]} />, workbench)
}

afterEach(() => RenderWithStore.cleanup())

describe("ResultsGrid.nextSorts", () => {
  it("cycles asc → desc → removed; shift keeps the other sorts", () => {
    const asc = ResultsGrid.nextSorts([], "a", false)
    expect(asc).toEqual([{ column: "a", direction: SortDirection.asc }])
    const desc = ResultsGrid.nextSorts(asc, "a", false)
    expect(desc).toEqual([{ column: "a", direction: SortDirection.desc }])
    expect(ResultsGrid.nextSorts(desc, "a", false)).toEqual([])
    expect(ResultsGrid.nextSorts(asc, "b", true)).toEqual([
      { column: "a", direction: SortDirection.asc },
      { column: "b", direction: SortDirection.asc }
    ])
    expect(ResultsGrid.nextSorts(asc, "b", false)).toEqual([{ column: "b", direction: SortDirection.asc }])
  })
})

describe("ResultsGrid", () => {
  it("a header click sorts; a filter cell filters", async () => {
    const workbench = await RenderWithStore.withResult()
    renderGrid(workbench)
    fireEvent.click(screen.getByText("name"))
    expect(selectActiveResult(workbench.store.getState().results).view.sorts).toEqual([
      { column: "name", direction: SortDirection.asc }
    ])
    fireEvent.change(screen.getByLabelText("Filter name"), { target: { value: "ali" } })
    expect(selectActiveResult(workbench.store.getState().results).view.filters).toEqual([{ column: "name", text: "ali" }])
  })

  it("click sets the cursor, arrows move it, double-click opens the inspector", async () => {
    const workbench = await RenderWithStore.withResult()
    renderGrid(workbench)
    fireEvent.click(screen.getByText("alice"))
    expect(workbench.store.getState().ui.cursor).toEqual({ rowIndex: 0, column: "name" })
    fireEvent.keyDown(screen.getByTestId("results-grid"), { key: "ArrowDown" })
    expect(workbench.store.getState().ui.cursor).toEqual({ rowIndex: 1, column: "name" })
    fireEvent.keyDown(screen.getByTestId("results-grid"), { key: "ArrowUp" })
    fireEvent.keyDown(screen.getByTestId("results-grid"), { key: "ArrowUp" })
    expect(workbench.store.getState().ui.cursor.rowIndex).toBe(0)
    fireEvent.doubleClick(screen.getByText("alice"))
    expect(workbench.store.getState().ui.inspector).toEqual({ rowIndex: 0, column: "name" })
  })

  it("Ctrl+C copies the cursor cell; the context menu copies a row", async () => {
    const workbench = await RenderWithStore.withResult(),
      writeText = jest.fn(async (_text: string) => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderGrid(workbench)
    fireEvent.click(screen.getByText("alice"))
    fireEvent.keyDown(screen.getByTestId("results-grid"), { key: "c", ctrlKey: true })
    expect(writeText).toHaveBeenCalledWith("alice")
    workbench.bridge.answers[IPCChannel.showContextMenu] = AppAction.copyRow
    fireEvent.contextMenu(screen.getByText("alice"))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    expect(writeText.mock.calls[1][0]).toContain("alice")
  })

  it("a dismissed context menu does nothing", async () => {
    const workbench = await RenderWithStore.withResult(),
      writeText = jest.fn(async () => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    workbench.bridge.answers[IPCChannel.showContextMenu] = AppAction.none
    renderGrid(workbench)
    fireEvent.contextMenu(screen.getByText("alice"))
    await waitFor(() =>
      expect(workbench.bridge.invoke).toHaveBeenCalledWith(IPCChannel.showContextMenu, {
        items: ContextMenuItems.of(...ResultsGrid.CellMenuActions)
      })
    )
    expect(writeText).not.toHaveBeenCalled()
  })

  it("highlights the focused find hit it is given", async () => {
    const workbench = await RenderWithStore.withResult(),
      tab = selectActiveResult(workbench.store.getState().results)
    RenderWithStore.render(<ResultsGrid tab={tab} view={ResultViews.of(tab)} hits={[{ rowIndex: 1, column: "name" }]} />, workbench)
    // The hit cell gets the highlight styling (its own emotion class); its non-hit column neighbour does not.
    expect(screen.getByText("bob").closest("td").className).not.toBe(screen.getByText("alice").closest("td").className)
  })
})
