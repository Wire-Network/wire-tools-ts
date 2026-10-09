import {
  CatalogSnapshot,
  ConnectionProfileDefaults,
  ConnectionProfilesDocument,
  PageSizeMode,
  QueryPager
} from "@wireio/ql-shared"

import { QueryPortStatus } from "@wireio/ql-tool-app/renderer/query"
import {
  CatalogActions,
  CatalogSlice,
  ConnectionsActions,
  ConnectionsSlice,
  HistoryActions,
  HistorySlice,
  MessageSeverity,
  ResultPanelKind,
  Results,
  ResultsActions,
  ResultsSlice,
  ResultTabStatus,
  SavedActions,
  SavedSlice,
  SliceName,
  Ui,
  UiActions,
  UiSlice,
  UiSurface,
  Workspace,
  WorkspaceActions,
  WorkspaceSlice,
  createWorkspaceInitialState,
  resolveActiveProfileName,
  selectActiveEditorTab,
  selectActiveProfile,
  selectActiveResult,
  selectProfileNamed,
  type ResultsState,
  type RunStart
} from "@wireio/ql-tool-app/renderer/store"

import { ConnectionFixtures } from "../../common/ConnectionFixtures.js"
import { ExecutionFixtures } from "../../common/ExecutionFixtures.js"

/** Fixture constants. */
namespace Fixture {
  export const At = "2026-10-07T12:00:00.000Z"
}

/** A profiles document with the named profiles. */
function documentOf(names: string[], defaultProfile: string = null): ConnectionProfilesDocument {
  return { defaultProfile, profiles: names.map(name => ({
      name,
      endpoint: ConnectionFixtures.Endpoint,
      transportTimeoutMs: ConnectionProfileDefaults.TransportTimeoutMs,
      retries: 0
    })) }
}

/** A run start. */
function runOf(requestId: string, query = "SELECT 1"): RunStart {
  return { query, profileName: "local", sourceEditorId: "editor-1", explicitWindow: null, requestId, at: Fixture.At }
}

describe("SliceName", () => {
  it("is an identity enum naming the seven slices", () => {
    expect(Object.entries(SliceName).every(([key, value]) => key === value)).toBe(true)
    expect(Object.keys(SliceName)).toHaveLength(7)
  })
})

describe("ConnectionsSlice", () => {
  it("keeps the active profile across reloads, else the default, else the first", () => {
    expect(resolveActiveProfileName(documentOf(["a", "b"]), "b")).toBe("b")
    expect(resolveActiveProfileName(documentOf(["a", "b"], "b"), "gone")).toBe("b")
    expect(resolveActiveProfileName(documentOf(["a", "b"]), null)).toBe("a")
    expect(resolveActiveProfileName(ConnectionProfilesDocument.empty(), "a")).toBeUndefined()
  })

  it("profilesLoaded / profileSelected / portStatusChanged", () => {
    let state = ConnectionsSlice.reducer(undefined, ConnectionsActions.profilesLoaded(documentOf(["a", "b"])))
    expect(selectActiveProfile(state).name).toBe("a")
    state = ConnectionsSlice.reducer(state, ConnectionsActions.profileSelected("b"))
    state = ConnectionsSlice.reducer(state, ConnectionsActions.portStatusChanged(QueryPortStatus.failed))
    expect(state.activeProfileName).toBe("b")
    expect(state.portStatus).toBe(QueryPortStatus.failed)
  })

  it("selectProfileNamed finds a profile by name (undefined when missing)", () => {
    const state = ConnectionsSlice.reducer(undefined, ConnectionsActions.profilesLoaded(documentOf(["a", "b"])))
    expect(selectProfileNamed(state, "b").name).toBe("b")
    expect(selectProfileNamed(state, "gone")).toBeUndefined()
  })
})

describe("WorkspaceSlice", () => {
  it("adds, activates and closes tabs; closing the last opens an empty one", () => {
    let state = WorkspaceSlice.reducer(undefined, WorkspaceActions.tabAdded({ text: "SELECT 2" }))
    expect(state.tabs.map(tab => tab.title)).toEqual(["Query 1", "Query 2"])
    expect(state.activeTabId).toBe("editor-2")
    state = WorkspaceSlice.reducer(state, WorkspaceActions.tabClosed("editor-2"))
    expect(state.activeTabId).toBe("editor-1")
    state = WorkspaceSlice.reducer(state, WorkspaceActions.tabClosed("editor-1"))
    expect(state.tabs.map(tab => tab.title)).toEqual(["Query 3"])
    expect(selectActiveEditorTab(state).id).toBe("editor-3")
  })

  it("unknown tab ids are ignored", () => {
    const initial = createWorkspaceInitialState(),
      state = WorkspaceSlice.reducer(initial, WorkspaceActions.tabActivated("nope"))
    expect(WorkspaceSlice.reducer(state, WorkspaceActions.tabClosed("nope"))).toEqual(initial)
  })

  it("text, selection and file association", () => {
    let state = WorkspaceSlice.reducer(undefined, WorkspaceActions.textChanged({ id: "editor-1", text: "SELECT 9" }))
    state = WorkspaceSlice.reducer(state, WorkspaceActions.selectionChanged({ id: "editor-1", selection: { start: 0, end: 6 } }))
    state = WorkspaceSlice.reducer(state, WorkspaceActions.fileAssociated({ id: "editor-1", filePath: "/tmp/q\\x.sql" }))
    expect(selectActiveEditorTab(state)).toMatchObject({ text: "SELECT 9", title: "x.sql", filePath: "/tmp/q\\x.sql" })
  })

  it("queryText runs a non-empty selection only when asked", () => {
    const tab = { ...Workspace.createTab(1, { text: "  SELECT 1; SELECT 2  " }), selection: { start: 2, end: 11 } }
    expect(Workspace.queryText(tab, true)).toBe("SELECT 1;")
    expect(Workspace.queryText(tab, false)).toBe("SELECT 1; SELECT 2")
    expect(Workspace.queryText({ ...tab, selection: { start: 4, end: 4 } }, true)).toBe("SELECT 1; SELECT 2")
  })
})

describe("ResultsSlice", () => {
  it("a run reuses the focused unpinned tab and resets page/view; pinned tabs are kept", () => {
    let state: ResultsState = ResultsSlice.reducer(undefined, ResultsActions.runStarted(runOf("r1")))
    state = ResultsSlice.reducer(state, ResultsActions.viewPatched({ resultId: "result-1", patch: { hiddenColumns: ["amount"] } }))
    state = ResultsSlice.reducer(state, ResultsActions.runStarted(runOf("r2", "SELECT 2")))
    expect(state.tabs).toHaveLength(1)
    expect(selectActiveResult(state)).toMatchObject({ query: "SELECT 2", requestId: "r2", view: { hiddenColumns: [] } })
    state = ResultsSlice.reducer(state, ResultsActions.pinToggled("result-1"))
    state = ResultsSlice.reducer(state, ResultsActions.runStarted(runOf("r3")))
    expect(state.tabs.map(tab => tab.id)).toEqual(["result-1", "result-2"])
    expect(state.tabs[0].query).toBe("SELECT 2")
  })

  it("executionFinished applies the matching request and ignores stale answers", () => {
    let state = ResultsSlice.reducer(undefined, ResultsActions.runStarted(runOf("r1")))
    state = ResultsSlice.reducer(state, ResultsActions.executionFinished({
      resultId: "result-1", requestId: "stale", execution: ExecutionFixtures.success("stale"), at: Fixture.At
    }))
    expect(selectActiveResult(state).status).toBe(ResultTabStatus.running)
    state = ResultsSlice.reducer(state, ResultsActions.executionFinished({
      resultId: "result-1", requestId: "r1", execution: ExecutionFixtures.failure("r1"), at: Fixture.At
    }))
    const tab = selectActiveResult(state)
    expect(tab.status).toBe(ResultTabStatus.failed)
    expect(tab.messages.at(-1).text).toBe("QUERY_SYNTAX: JOIN is not supported")
  })

  it("pageRequested records the previous block and drops the explicit window", () => {
    let state = ResultsSlice.reducer(undefined, ResultsActions.runStarted({ ...runOf("r1"), explicitWindow: { offset: 5, limit: 2 } }))
    expect(Results.windowOf(selectActiveResult(state))).toEqual({ offset: 5, limit: 2 })
    state = ResultsSlice.reducer(state, ResultsActions.executionFinished({
      resultId: "result-1", requestId: "r1", execution: ExecutionFixtures.success("r1"), at: Fixture.At
    }))
    state = ResultsSlice.reducer(state, ResultsActions.pageRequested({
      resultId: "result-1", requestId: "r2", pager: { mode: PageSizeMode.paged, pageSize: 2, page: 2 }, at: Fixture.At
    }))
    const tab = selectActiveResult(state)
    expect(tab.previousBlockId).toBe(Results.blockIdOf(ExecutionFixtures.success("r1")))
    expect(Results.windowOf(tab)).toEqual({ offset: 2, limit: 2 })
  })

  it("closing the focused tab focuses its neighbour, then none", () => {
    let state = ResultsSlice.reducer(undefined, ResultsActions.runStarted(runOf("r1")))
    state = ResultsSlice.reducer(state, ResultsActions.pinToggled("result-1"))
    state = ResultsSlice.reducer(state, ResultsActions.runStarted(runOf("r2")))
    state = ResultsSlice.reducer(state, ResultsActions.resultClosed("result-2"))
    expect(state.activeResultId).toBe("result-1")
    state = ResultsSlice.reducer(state, ResultsActions.resultClosed("result-1"))
    expect(state.activeResultId).toBeUndefined()
    expect(ResultsSlice.reducer(state, ResultsActions.panelSelected(ResultPanelKind.json)).activePanel).toBe(
      ResultPanelKind.json
    )
  })

  it("defaultPager / describe of a success", () => {
    expect(Results.defaultPager()).toEqual({
      mode: PageSizeMode.paged, pageSize: QueryPager.DefaultPageSize, page: QueryPager.FirstPage
    })
    expect(Results.describe(ExecutionFixtures.success("r"))).toBe("3 of 3 rows · 1200 µs server · 4.3 ms wall · block 1000")
    expect(Results.blockIdOf(ExecutionFixtures.failure("r"))).toBeNull()
    expect(Results.describe(ExecutionFixtures.failure("r"))).toBe("QUERY_SYNTAX: JOIN is not supported")
  })

  it("emptyView / createTab build a new running tab", () => {
    const message = { at: Fixture.At, severity: MessageSeverity.info, text: "Running: SELECT 1" },
      tab = Results.createTab(7, runOf("r7"), message)
    expect(Results.emptyView()).toEqual({ sorts: [], filters: [], hiddenColumns: [] })
    expect(tab).toMatchObject({
      id: `${Results.ResultIdPrefix}7`,
      title: `${Results.TitlePrefix} 7`,
      pinned: false,
      requestId: "r7",
      status: ResultTabStatus.running,
      pager: Results.defaultPager(),
      view: Results.emptyView(),
      messages: [message]
    })
  })

  it("the Messages log keeps the newest MaxMessages lines", () => {
    const tab = Results.createTab(1, runOf("r1"), { at: Fixture.At, severity: MessageSeverity.info, text: "line 0" })
    Array.from({ length: Results.MaxMessages + 5 }, (_value, index) =>
      Results.appendMessage(tab, { at: Fixture.At, severity: MessageSeverity.info, text: `line ${index + 1}` })
    )
    expect(tab.messages).toHaveLength(Results.MaxMessages)
    expect(tab.messages.at(-1).text).toBe(`line ${Results.MaxMessages + 5}`)
    expect(tab.messages[0].text).toBe("line 6")
  })

  it("viewPatched merges the patch into the view; unknown tabs are ignored", () => {
    let state = ResultsSlice.reducer(undefined, ResultsActions.runStarted(runOf("r1")))
    state = ResultsSlice.reducer(state, ResultsActions.viewPatched({ resultId: "result-1", patch: { hiddenColumns: ["a"] } }))
    state = ResultsSlice.reducer(state, ResultsActions.viewPatched({ resultId: "result-1", patch: { filters: [{ column: "b", text: "x" }] } }))
    expect(selectActiveResult(state).view).toEqual({ sorts: [], filters: [{ column: "b", text: "x" }], hiddenColumns: ["a"] })
    expect(ResultsSlice.reducer(state, ResultsActions.viewPatched({ resultId: "nope", patch: { sorts: [] } }))).toEqual(state)
  })
})

describe("CatalogSlice", () => {
  it("tracks loading owners and failures", () => {
    const snapshot = { endpoint: ConnectionFixtures.Endpoint, owners: [], capturedAt: Fixture.At } as CatalogSnapshot
    let state = CatalogSlice.reducer(undefined, CatalogActions.catalogReset(snapshot))
    state = CatalogSlice.reducer(state, CatalogActions.ownerLoading("sample"))
    state = CatalogSlice.reducer(state, CatalogActions.ownerLoading("sample"))
    expect(state.loadingOwners).toEqual(["sample"])
    state = CatalogSlice.reducer(state, CatalogActions.catalogFailed({ owner: "sample", message: "abi missing" }))
    expect(state).toMatchObject({ loadingOwners: [], error: "abi missing" })
    state = CatalogSlice.reducer(state, CatalogActions.snapshotLoaded({ owner: null, snapshot }))
    expect(state.error).toBeNull()
  })
})

describe("History / Saved slices", () => {
  it("load entries and search text", () => {
    const history = HistorySlice.reducer(undefined, HistoryActions.searchChanged("accounts"))
    expect(history).toEqual({ entries: [], search: "accounts" })
    expect(SavedSlice.reducer(undefined, SavedActions.savedLoaded([])).queries).toEqual([])
  })
})

describe("UiSlice", () => {
  it("opens, toggles and closes surfaces without duplicates", () => {
    let state = UiSlice.reducer(undefined, UiActions.surfaceOpened(UiSurface.history))
    state = UiSlice.reducer(state, UiActions.surfaceOpened(UiSurface.history))
    state = UiSlice.reducer(state, UiActions.surfaceToggled(UiSurface.saved))
    expect(state.open).toEqual([UiSurface.history, UiSurface.saved])
    state = UiSlice.reducer(state, UiActions.surfaceToggled(UiSurface.history))
    state = UiSlice.reducer(state, UiActions.surfaceClosed(UiSurface.saved))
    expect(state.open).toEqual([])
  })

  it("find text resets the hit index", () => {
    let state = UiSlice.reducer(undefined, UiActions.findHitSelected(4))
    state = UiSlice.reducer(state, UiActions.findTextChanged("alice"))
    expect(state).toMatchObject({ findText: "alice", findHitIndex: 0 })
  })

  it("explicitWindowOf parses the toolbar fields (blank/invalid → unset)", () => {
    expect(Ui.explicitWindowOf({ offset: "", limit: "" })).toBeNull()
    expect(Ui.explicitWindowOf({ offset: " 20 ", limit: "" })).toEqual({ offset: 20, limit: null })
    expect(Ui.explicitWindowOf({ offset: "-1", limit: "5" })).toEqual({ offset: 0, limit: 5 })
    expect(Ui.parseCount("1.5")).toBeNull()
  })
})
