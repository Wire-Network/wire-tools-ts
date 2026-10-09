import { PageSizeMode, QueryEngineClient, QueryFailureKind, QueryOutcome, type QueryHistoryEntry } from "@wireio/ql-shared"

import { IPCChannel } from "@wireio/ql-tool-app/common"
import { QueryPortError } from "@wireio/ql-tool-app/renderer/query"
import {
  ConnectionsActions,
  QueryRun,
  ResultTabStatus,
  UiActions,
  UiSurface,
  WorkspaceActions,
  fetchPage,
  formatQuery,
  retryQuery,
  openAndRunQuery,
  runQuery,
  selectActiveEditorTab,
  selectActiveResult,
  stopQuery
} from "@wireio/ql-tool-app/renderer/store"

import { ExecutionFixtures } from "../../../common/ExecutionFixtures.js"
import { FakeWorkbench } from "../../../common/FakeWorkbench.js"

/** A workbench with one active profile and SQL in the editor. */
function readyWorkbench(text = ExecutionFixtures.PositionsQuery): FakeWorkbench {
  const workbench = FakeWorkbench.create()
  workbench.store.dispatch(ConnectionsActions.profilesLoaded(FakeWorkbench.profilesOf("local")))
  workbench.store.dispatch(WorkspaceActions.textChanged({ id: "editor-1", text }))
  workbench.bridge.answers[IPCChannel.historyList] = []
  return workbench
}

describe("openAndRunQuery", () => {
  it("opens the seed in a new focused tab and runs exactly that SQL", async () => {
    const workbench = readyWorkbench(),
      tabsBefore = workbench.store.getState().workspace.tabs.length
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
    await workbench.store.dispatch(openAndRunQuery({ text: "SELECT 5", title: "five" }))
    expect(workbench.store.getState().workspace.tabs).toHaveLength(tabsBefore + 1)
    expect(selectActiveEditorTab(workbench.store.getState().workspace)).toMatchObject({ title: "five", text: "SELECT 5" })
    expect(workbench.queryPort.execute).toHaveBeenCalledWith(expect.objectContaining({ query: "SELECT 5" }))
    expect(selectActiveResult(workbench.store.getState().results).status).toBe(ResultTabStatus.succeeded)
  })

  it("a blank seed opens the tab but runs nothing", async () => {
    const workbench = readyWorkbench()
    await workbench.store.dispatch(openAndRunQuery({ text: "  " }))
    expect(selectActiveEditorTab(workbench.store.getState().workspace).text).toBe("  ")
    expect(workbench.queryPort.execute).not.toHaveBeenCalled()
  })
})

describe("runQuery", () => {
  it("executes the editor SQL, stores the outcome and appends history", async () => {
    const workbench = readyWorkbench()
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
    await workbench.store.dispatch(runQuery(false))
    expect(workbench.queryPort.execute).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-1", query: ExecutionFixtures.PositionsQuery, mode: PageSizeMode.paged })
    )
    expect(selectActiveResult(workbench.store.getState().results).status).toBe(ResultTabStatus.succeeded)
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyAppend)).toEqual([
      expect.objectContaining({ id: "req-1", profile: "local", outcome: QueryOutcome.success, returnedRows: 3 })
    ])
  })

  it("a lost port becomes a transport failure tab, not a throw", async () => {
    const workbench = readyWorkbench()
    workbench.queryPort.execute.mockRejectedValue(QueryPortError.lost(QueryPortError.HostExited))
    await workbench.store.dispatch(runQuery(false))
    const tab = selectActiveResult(workbench.store.getState().results)
    expect(tab.status).toBe(ResultTabStatus.failed)
    expect(tab.execution.status === "failure" && tab.execution.failure).toMatchObject({
      kind: QueryFailureKind.transport,
      message: QueryPortError.HostExited
    })
  })

  it("without a profile opens the connection manager and runs nothing", async () => {
    const workbench = FakeWorkbench.create()
    await workbench.store.dispatch(runQuery(false))
    expect(workbench.store.getState().ui.open).toEqual([UiSurface.connections])
    expect(workbench.queryPort.execute).not.toHaveBeenCalled()
  })

  it("blank SQL runs nothing; the toolbar window is passed through", async () => {
    const blank = readyWorkbench("   ")
    await blank.store.dispatch(runQuery(false))
    expect(blank.queryPort.execute).not.toHaveBeenCalled()
    const windowed = readyWorkbench()
    windowed.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
    windowed.store.dispatch(UiActions.windowFieldsChanged({ offset: "10", limit: "5" }))
    await windowed.store.dispatch(runQuery(false))
    expect(windowed.queryPort.execute.mock.calls[0][0].window).toEqual({ offset: 10, limit: 5 })
  })

  it("a failed history append is logged and leaves the result intact", async () => {
    const workbench = readyWorkbench()
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
    workbench.bridge.invoke.mockImplementation(async (channel: IPCChannel) => {
      if (channel === IPCChannel.historyAppend) throw new Error("disk full")
      return undefined
    })
    await workbench.store.dispatch(runQuery(false))
    expect(selectActiveResult(workbench.store.getState().results).status).toBe(ResultTabStatus.succeeded)
  })
})

describe("fetchPage / retryQuery / stopQuery", () => {
  it("fetches page 2 of the focused result with a new request id", async () => {
    const workbench = readyWorkbench()
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
    await workbench.store.dispatch(runQuery(false))
    await workbench.store.dispatch(fetchPage({ mode: PageSizeMode.paged, pageSize: 2, page: 2 }))
    expect(workbench.queryPort.execute.mock.calls[1][0]).toMatchObject({ requestId: "req-2", window: { offset: 2, limit: 2 } })
  })

  it("retry re-runs the current window; without a result nothing happens", async () => {
    const empty = readyWorkbench()
    await empty.store.dispatch(retryQuery())
    expect(empty.queryPort.execute).not.toHaveBeenCalled()
    const workbench = readyWorkbench()
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.failure(requestId))
    await workbench.store.dispatch(runQuery(false))
    await workbench.store.dispatch(retryQuery())
    expect(workbench.queryPort.execute).toHaveBeenCalledTimes(2)
  })

  it("stop cancels the focused request", async () => {
    const workbench = readyWorkbench()
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
    await workbench.store.dispatch(runQuery(false))
    await workbench.store.dispatch(stopQuery())
    expect(workbench.queryPort.cancel).toHaveBeenCalledWith("req-1")
  })
})

describe("formatQuery", () => {
  it("formats parsable SQL", async () => {
    const workbench = readyWorkbench("select name from sample.positions where amount > 1")
    await workbench.store.dispatch(formatQuery())
    expect(selectActiveEditorTab(workbench.store.getState().workspace).text).toMatch(/^SELECT/)
  })

  it("unparsable SQL is left alone with a notice", async () => {
    const workbench = readyWorkbench("SELECT FROM WHERE (")
    await workbench.store.dispatch(formatQuery())
    expect(selectActiveEditorTab(workbench.store.getState().workspace).text).toBe("SELECT FROM WHERE (")
    expect(workbench.store.getState().ui.notice).toMatch(new RegExp(`^${QueryRun.FormatLabel} failed: `))
  })
})

describe("QueryRun", () => {
  it("portFailure keeps a QueryPortError's failure and wraps anything else as transport", () => {
    const fromPort = QueryRun.portFailure("r", "q", QueryPortError.lost(QueryPortError.HostFailed)),
      fromOther = QueryRun.portFailure("r", "q", "boom")
    expect(fromPort.status === "failure" && fromPort.failure.message).toBe(QueryPortError.HostFailed)
    expect(fromOther.status === "failure" && fromOther.failure).toMatchObject({
      kind: QueryFailureKind.transport,
      message: "boom"
    })
  })

  it("executeOrFail returns the port's outcome, or a failure outcome when the call throws", async () => {
    const workbench = readyWorkbench(),
      params = {
        requestId: "e1",
        profile: FakeWorkbench.profilesOf("local").profiles[0],
        query: "SELECT 1",
        window: { offset: 0, limit: 10 },
        mode: PageSizeMode.paged
      }
    workbench.queryPort.execute.mockResolvedValueOnce(ExecutionFixtures.success("e1"))
    await expect(QueryRun.executeOrFail(workbench.services, params)).resolves.toMatchObject({ requestId: "e1", status: "success" })
    workbench.queryPort.execute.mockRejectedValueOnce(new QueryPortError(QueryEngineClient.cancelledFailure()))
    await expect(QueryRun.executeOrFail(workbench.services, params)).resolves.toMatchObject({
      requestId: "e1",
      query: "SELECT 1",
      attempts: 0,
      failure: QueryEngineClient.cancelledFailure()
    })
  })

  it("recordHistory appends one entry and reloads the drawer; a failed append is only logged", async () => {
    const workbench = readyWorkbench(),
      profile = FakeWorkbench.profilesOf("local").profiles[0]
    await workbench.store.dispatch(QueryRun.recordHistory(ExecutionFixtures.success("h1"), profile))
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyAppend)).toEqual([expect.objectContaining({ id: "h1" })])
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyList)).toHaveLength(1)
    workbench.bridge.invoke.mockRejectedValueOnce(new Error("disk full"))
    await expect(workbench.store.dispatch(QueryRun.recordHistory(ExecutionFixtures.success("h2"), profile))).resolves.toBeUndefined()
    expect(workbench.store.getState().ui.notice).toBeNull()
  })
})

describe("history: one entry per user-initiated request", () => {
  it("a run, a retry and a page fetch each record exactly one entry", async () => {
    const workbench = readyWorkbench()
    workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
    await workbench.store.dispatch(runQuery(false))
    await workbench.store.dispatch(retryQuery())
    await workbench.store.dispatch(fetchPage({ mode: PageSizeMode.paged, pageSize: 1, page: 2 }))
    expect((FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyAppend) as QueryHistoryEntry[]).map(entry => entry.id)).toEqual([
      "req-1",
      "req-2",
      "req-3"
    ])
    expect(workbench.queryPort.execute).toHaveBeenCalledTimes(3)
  })
})
