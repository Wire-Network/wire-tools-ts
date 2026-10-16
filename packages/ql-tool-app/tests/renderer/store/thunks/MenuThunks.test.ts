import { AppAction, ContextMenuItems, IPCChannel } from "@wireio/ql-tool-app/common"
import { MenuThunks, showContextMenu } from "@wireio/ql-tool-app/renderer/store"

import { FakeWorkbench } from "../../../common/FakeWorkbench.js"

describe("showContextMenu", () => {
  it("asks main for a menu of the registry-labelled actions and resolves the choice", async () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.answers[IPCChannel.showContextMenu] = AppAction.copyRow
    await expect(workbench.store.dispatch(showContextMenu(AppAction.copyCell, AppAction.copyRow))).resolves.toBe(AppAction.copyRow)
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.showContextMenu)).toEqual([
      { items: ContextMenuItems.of(AppAction.copyCell, AppAction.copyRow) }
    ])
  })

  it("a menu that cannot be shown resolves none and leaves a notice", async () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.invoke.mockRejectedValue(new Error("no window"))
    await expect(workbench.store.dispatch(showContextMenu(AppAction.copyCell))).resolves.toBe(AppAction.none)
    expect(workbench.store.getState().ui.notice).toBe(`${MenuThunks.ContextMenuLabel} failed: no window`)
  })
})
