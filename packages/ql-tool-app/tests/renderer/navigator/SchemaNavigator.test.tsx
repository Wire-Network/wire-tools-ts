/**
 * @jest-environment jsdom
 */
import { fireEvent, screen, waitFor } from "@testing-library/react"

import { ActionRegistry, AppAction, ContextMenuItems, IPCChannel } from "@wireio/ql-tool-app/common"
import { SchemaNavigator } from "@wireio/ql-tool-app/renderer/navigator"
import { CatalogActions, ConnectionsActions, selectActiveEditorTab } from "@wireio/ql-tool-app/renderer/store"

import { CatalogFixtures } from "../../common/CatalogFixtures.js"
import { ExecutionFixtures } from "../../common/ExecutionFixtures.js"
import { FakeWorkbench } from "../../common/FakeWorkbench.js"
import { RenderWithStore } from "../../common/RenderWithStore.js"

/** A workbench with an active profile and the fixture catalog. */
function catalogWorkbench(): FakeWorkbench {
  const workbench = FakeWorkbench.create()
  workbench.store.dispatch(ConnectionsActions.profilesLoaded(FakeWorkbench.profilesOf("local")))
  workbench.store.dispatch(CatalogActions.catalogReset(CatalogFixtures.loaded()))
  return workbench
}

afterEach(() => RenderWithStore.cleanup())

describe("SchemaNavigator", () => {
  it("asks for a connection before any catalog exists", () => {
    RenderWithStore.render(<SchemaNavigator />)
    expect(screen.getByText("Add a connection to browse the schema.")).toBeInTheDocument()
  })

  it("expanding an unloaded owner loads its ABI", async () => {
    const workbench = catalogWorkbench()
    workbench.queryPort.loadOwner.mockResolvedValue(CatalogFixtures.loaded())
    RenderWithStore.render(<SchemaNavigator />, workbench)
    fireEvent.click(screen.getByText("other"))
    await waitFor(() => expect(workbench.queryPort.loadOwner).toHaveBeenCalledWith("req-1", expect.anything(), "other"))
  })

  it("table context menu: Select Rows opens a LIMIT 100 tab and runs it", async () => {
    const workbench = catalogWorkbench()
    workbench.bridge.answers[IPCChannel.showContextMenu] = AppAction.selectRows
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
    RenderWithStore.render(<SchemaNavigator />, workbench)
    fireEvent.click(screen.getByText("sample"))
    fireEvent.contextMenu(screen.getByText("positions"))
    await waitFor(() =>
      expect(selectActiveEditorTab(workbench.store.getState().workspace).text).toBe(
        SchemaNavigator.selectRowsQuery("sample", "positions")
      )
    )
    await waitFor(() => expect(workbench.queryPort.execute).toHaveBeenCalled())
    expect(SchemaNavigator.selectRowsQuery("sample", "positions")).toMatch(new RegExp(`LIMIT ${ActionRegistry.SelectRowsLimit}$`))
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.showContextMenu)).toEqual([
      { items: ContextMenuItems.of(...SchemaNavigator.TableMenuActions) }
    ])
    expect(workbench.store.getState().workspace.tabs).toHaveLength(2)
  })

  it("shows the catalog error and labels key fields", () => {
    const workbench = catalogWorkbench(),
      [table] = CatalogFixtures.loaded().owners[0].tables
    workbench.store.dispatch(CatalogActions.catalogFailed({ owner: null, message: "abi missing" }))
    RenderWithStore.render(<SchemaNavigator />, workbench)
    expect(screen.getByText("abi missing")).toBeInTheDocument()
    expect(SchemaNavigator.fieldLabel(table, 0)).toBe(`key.id : uint64${SchemaNavigator.KeySuffix}`)
    expect(SchemaNavigator.fieldLabel(table, 1)).toBe("name : name · text")
  })
})
