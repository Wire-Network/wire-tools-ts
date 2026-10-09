/**
 * @jest-environment jsdom
 */
import { fireEvent, screen, waitFor } from "@testing-library/react"

import { IPCChannel } from "@wireio/ql-tool-app/common"
import { QueryDrawer } from "@wireio/ql-tool-app/renderer/components"
import { HistoryPanel } from "@wireio/ql-tool-app/renderer/history"
import { HistoryActions, UiActions, UiSurface, selectActiveEditorTab } from "@wireio/ql-tool-app/renderer/store"

import { FakeWorkbench } from "../../common/FakeWorkbench.js"
import { HistoryFixtures } from "../../common/HistoryFixtures.js"
import { RenderWithStore } from "../../common/RenderWithStore.js"

afterEach(() => RenderWithStore.cleanup())

describe("HistoryPanel", () => {
  it("lists entries; a click opens the SQL; search reloads once typing pauses; Clear empties", () => {
    jest.useFakeTimers()
    const workbench = FakeWorkbench.create()
    workbench.bridge.answers[IPCChannel.historyList] = []
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.history))
    workbench.store.dispatch(HistoryActions.historyLoaded([HistoryFixtures.entry("h1", "SELECT 42")]))
    RenderWithStore.render(<HistoryPanel />, workbench)
    expect(screen.getByTestId("history-list")).toHaveTextContent("success · 1 rows")
    fireEvent.click(screen.getByText("SELECT 42"))
    expect(selectActiveEditorTab(workbench.store.getState().workspace).text).toBe("SELECT 42")
    fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "4" } })
    fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "42" } })
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyList)).toEqual([])
    jest.advanceTimersByTime(HistoryPanel.SearchDebounceMs)
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyList)).toEqual([{ limit: 200, search: "42" }])
    fireEvent.click(screen.getByText("Clear"))
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyClear)).toHaveLength(1)
    jest.useRealTimers()
  })

  it("unmounting cancels a pending search reload", () => {
    jest.useFakeTimers()
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.history))
    const { unmount } = RenderWithStore.render(<HistoryPanel />, workbench)
    fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "x" } })
    unmount()
    jest.advanceTimersByTime(HistoryPanel.SearchDebounceMs)
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyList)).toEqual([])
    jest.useRealTimers()
  })

  it("describe joins time, profile, outcome and (when known) the row count", () => {
    expect(HistoryPanel.describe(HistoryFixtures.entry("h", "q"))).toBe(`${HistoryFixtures.ExecutedAt} · ${HistoryFixtures.ProfileName} · success · 1 rows`)
    expect(HistoryPanel.describe({ ...HistoryFixtures.entry("h", "q"), returnedRows: null })).toBe(
      `${HistoryFixtures.ExecutedAt} · ${HistoryFixtures.ProfileName} · success`
    )
  })

  it("Re-run opens the entry in a new tab and runs it (clicking the row only opens it)", async () => {
    const workbench = FakeWorkbench.createRunnable()
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.history))
    workbench.store.dispatch(HistoryActions.historyLoaded([HistoryFixtures.entry("h1", "SELECT 1"), HistoryFixtures.entry("h2", "SELECT 2")]))
    RenderWithStore.render(<HistoryPanel />, workbench)
    fireEvent.click(screen.getByText("SELECT 1"))
    expect(workbench.queryPort.execute).not.toHaveBeenCalled()
    const tabsBefore = workbench.store.getState().workspace.tabs.length
    fireEvent.click(screen.getByRole("button", { name: `${QueryDrawer.RerunLabel} h2` }))
    await waitFor(() => expect(workbench.queryPort.execute).toHaveBeenCalledTimes(1))
    expect(workbench.queryPort.execute.mock.calls[0][0]).toMatchObject({ query: "SELECT 2" })
    expect(workbench.store.getState().workspace.tabs).toHaveLength(tabsBefore + 1)
    expect(selectActiveEditorTab(workbench.store.getState().workspace).text).toBe("SELECT 2")
  })

  it("Close closes the drawer", () => {
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.history))
    RenderWithStore.render(<HistoryPanel />, workbench)
    fireEvent.click(screen.getByText("Close"))
    expect(workbench.store.getState().ui.open).toEqual([])
  })
})
