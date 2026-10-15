import { AppAction, IPCChannel, IPCEventChannel, StoreKind, ThemeSource } from "@wireio/ql-tool-app/common"
import { MenuActions } from "@wireio/ql-tool-app/renderer/ipc"
import type { QueryPortClient } from "@wireio/ql-tool-app/renderer/query"
import { UiSurface } from "@wireio/ql-tool-app/renderer/store"

import { FakeWorkbench } from "../../common/FakeWorkbench.js"

/** A menu context over a fake workbench. */
function contextOf(workbench: FakeWorkbench): Parameters<typeof MenuActions.perform>[0] {
  return {
    dispatch: workbench.store.dispatch,
    getState: workbench.store.getState,
    bridge: workbench.bridge,
    queryPort: { restart: jest.fn() } as unknown as QueryPortClient
  }
}

describe("MenuActions.perform", () => {
  it("tab actions edit the workspace", () => {
    const workbench = FakeWorkbench.create(),
      context = contextOf(workbench)
    MenuActions.perform(context, AppAction.newTab)
    expect(workbench.store.getState().workspace.tabs).toHaveLength(2)
    MenuActions.perform(context, AppAction.closeTab)
    expect(workbench.store.getState().workspace.tabs).toHaveLength(1)
  })

  it("surface actions open / toggle their surfaces", () => {
    const workbench = FakeWorkbench.create(),
      context = contextOf(workbench)
    MenuActions.perform(context, AppAction.connections)
    MenuActions.perform(context, AppAction.toggleHistory)
    MenuActions.perform(context, AppAction.exportResults)
    expect(workbench.store.getState().ui.open).toEqual([UiSurface.connections, UiSurface.history, UiSurface.export])
    MenuActions.perform(context, AppAction.toggleHistory)
    expect(workbench.store.getState().ui.open).not.toContain(UiSurface.history)
  })

  it("Restart goes to the query port; appearance goes to main", () => {
    const workbench = FakeWorkbench.create(),
      context = contextOf(workbench)
    MenuActions.perform(context, AppAction.restartQueryHost)
    MenuActions.perform(context, AppAction.appearanceDark)
    expect(context.queryPort.restart).toHaveBeenCalled()
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.setThemeSource)).toEqual([{ source: ThemeSource.dark }])
  })

  it("context-menu-only actions are no-ops here", () => {
    const workbench = FakeWorkbench.create(),
      before = workbench.store.getState()
    MenuActions.perform(contextOf(workbench), AppAction.copyCell)
    expect(workbench.store.getState()).toBe(before)
  })
})

describe("MenuActions.reloadStore / subscribe", () => {
  it("each store kind reloads its slice through the bridge", () => {
    const workbench = FakeWorkbench.create()
    MenuActions.reloadStore(workbench.store.dispatch, StoreKind.saved)
    MenuActions.reloadStore(workbench.store.dispatch, StoreKind.history)
    MenuActions.reloadStore(workbench.store.dispatch, StoreKind.profiles)
    expect(workbench.bridge.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      IPCChannel.savedList,
      IPCChannel.historyList,
      IPCChannel.profilesList
    ])
  })

  it("subscribes to menuAction + storeChanged and unsubscribes both", () => {
    const workbench = FakeWorkbench.create(),
      unsubscribes = [jest.fn(), jest.fn()]
    workbench.bridge.on.mockReturnValueOnce(unsubscribes[0]).mockReturnValueOnce(unsubscribes[1])
    const unsubscribe = MenuActions.subscribe(contextOf(workbench))
    expect(workbench.bridge.on.mock.calls.map(([channel]) => channel)).toEqual([
      IPCEventChannel.menuAction,
      IPCEventChannel.storeChanged
    ])
    const [, onMenuAction] = workbench.bridge.on.mock.calls[0]
    onMenuAction(AppAction.toggleSaved)
    expect(workbench.store.getState().ui.open).toEqual([UiSurface.saved])
    unsubscribe()
    unsubscribes.forEach(fn => expect(fn).toHaveBeenCalled())
  })
})
