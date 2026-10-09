import { IPCChannel } from "@wireio/ql-tool-app/common"
import {
  History,
  WorkspaceActions,
  clearHistory,
  loadHistory,
  loadProfiles,
  loadSaved,
  removeProfile,
  removeSaved,
  saveCurrentQuery,
  saveProfile,
  selectProfile,
  setDefaultProfile
} from "@wireio/ql-tool-app/renderer/store"

import { FakeWorkbench } from "../../../common/FakeWorkbench.js"

describe("PersistenceThunks", () => {
  it("loadProfiles stores the document and resets the catalog for the new active profile", async () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.answers[IPCChannel.profilesList] = FakeWorkbench.profilesOf("local")
    await workbench.store.dispatch(loadProfiles())
    const state = workbench.store.getState()
    expect(state.connections.activeProfileName).toBe("local")
    expect(state.catalog.snapshot.owners.map(owner => owner.account)).toEqual(["sample"])
  })

  it("a failing store call becomes a notice, not a rejection", async () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.invoke.mockRejectedValue(new Error("EACCES"))
    await expect(workbench.store.dispatch(loadProfiles())).resolves.toBeUndefined()
    expect(workbench.store.getState().ui.notice).toBe("Loading connections failed: EACCES")
  })

  it("profile upsert / remove / default / select go through their channels", async () => {
    const workbench = FakeWorkbench.create(),
      document = FakeWorkbench.profilesOf("a", "b")
    Object.assign(workbench.bridge.answers, {
      [IPCChannel.profilesUpsert]: document,
      [IPCChannel.profilesRemove]: FakeWorkbench.profilesOf("a"),
      [IPCChannel.profilesSetDefault]: document
    })
    await workbench.store.dispatch(saveProfile(document.profiles[1]))
    await workbench.store.dispatch(selectProfile("b"))
    expect(workbench.store.getState().connections.activeProfileName).toBe("b")
    await workbench.store.dispatch(setDefaultProfile("b"))
    await workbench.store.dispatch(removeProfile("b"))
    expect(workbench.store.getState().connections.activeProfileName).toBe("a")
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.profilesRemove)).toEqual([{ name: "b" }])
  })

  it("history load applies the search; clear empties it", async () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.answers[IPCChannel.historyList] = []
    await workbench.store.dispatch(loadHistory())
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyList)).toEqual([
      { limit: History.ListLimit, search: "" }
    ])
    await workbench.store.dispatch(clearHistory())
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyClear)).toHaveLength(1)
  })

  it("saves the editor text under a name and removes by id", async () => {
    const workbench = FakeWorkbench.create(),
      saved = [{ id: "s1", name: "q", query: "SELECT 1", createdAt: "x", updatedAt: "x" }]
    Object.assign(workbench.bridge.answers, {
      [IPCChannel.savedUpsert]: saved,
      [IPCChannel.savedList]: saved,
      [IPCChannel.savedRemove]: []
    })
    workbench.store.dispatch(WorkspaceActions.textChanged({ id: "editor-1", text: "SELECT 1" }))
    await workbench.store.dispatch(saveCurrentQuery("q"))
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.savedUpsert)).toEqual([{ name: "q", query: "SELECT 1" }])
    await workbench.store.dispatch(loadSaved())
    expect(workbench.store.getState().saved.queries).toHaveLength(1)
    await workbench.store.dispatch(removeSaved("s1"))
    expect(workbench.store.getState().saved.queries).toEqual([])
  })
})
