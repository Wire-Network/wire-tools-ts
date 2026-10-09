/**
 * @jest-environment jsdom
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react"

import { IPCChannel } from "@wireio/ql-tool-app/common"
import { QueryDrawer } from "@wireio/ql-tool-app/renderer/components"
import { SavedQueriesPanel } from "@wireio/ql-tool-app/renderer/saved"
import { SavedActions, UiActions, UiSurface, selectActiveEditorTab } from "@wireio/ql-tool-app/renderer/store"

import { FakeWorkbench } from "../../common/FakeWorkbench.js"
import { RenderWithStore } from "../../common/RenderWithStore.js"

afterEach(() => RenderWithStore.cleanup())

describe("SavedQueriesPanel", () => {
  it("opens a saved query titled by its name; Delete removes by id; Save current opens the dialog", () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.answers[IPCChannel.savedRemove] = []
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.saved))
    workbench.store.dispatch(
      SavedActions.savedLoaded([{ id: "s1", name: "daily", query: "SELECT 1", createdAt: "x", updatedAt: "x" }])
    )
    RenderWithStore.render(<SavedQueriesPanel />, workbench)
    fireEvent.click(screen.getByText("daily"))
    expect(selectActiveEditorTab(workbench.store.getState().workspace)).toMatchObject({ title: "daily", text: "SELECT 1" })
    fireEvent.click(within(screen.getByTestId("saved-list")).getByText("Delete"))
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.savedRemove)).toEqual([{ name: "s1" }])
    fireEvent.click(screen.getByText("Save current…"))
    expect(workbench.store.getState().ui.open).toContain(UiSurface.saveQuery)
  })

  it("Re-run opens the saved query titled by its name and runs it", async () => {
    const workbench = FakeWorkbench.createRunnable()
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.saved))
    workbench.store.dispatch(
      SavedActions.savedLoaded([{ id: "s1", name: "daily", query: "SELECT 9", createdAt: "x", updatedAt: "x" }])
    )
    RenderWithStore.render(<SavedQueriesPanel />, workbench)
    fireEvent.click(screen.getByRole("button", { name: `${QueryDrawer.RerunLabel} daily` }))
    await waitFor(() => expect(workbench.queryPort.execute).toHaveBeenCalledTimes(1))
    expect(workbench.queryPort.execute.mock.calls[0][0]).toMatchObject({ query: "SELECT 9" })
    expect(selectActiveEditorTab(workbench.store.getState().workspace)).toMatchObject({ title: "daily", text: "SELECT 9" })
  })

  it("Re-run without a profile opens the connection manager and runs nothing", async () => {
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.saved))
    workbench.store.dispatch(
      SavedActions.savedLoaded([{ id: "s1", name: "daily", query: "SELECT 9", createdAt: "x", updatedAt: "x" }])
    )
    RenderWithStore.render(<SavedQueriesPanel />, workbench)
    fireEvent.click(screen.getByRole("button", { name: `${QueryDrawer.RerunLabel} daily` }))
    await waitFor(() => expect(workbench.store.getState().ui.open).toContain(UiSurface.connections))
    expect(workbench.queryPort.execute).not.toHaveBeenCalled()
  })

  it("an empty list renders no rows", () => {
    const workbench = FakeWorkbench.create()
    workbench.store.dispatch(UiActions.surfaceOpened(UiSurface.saved))
    RenderWithStore.render(<SavedQueriesPanel />, workbench)
    expect(screen.getByTestId("saved-list").children).toHaveLength(0)
  })
})
