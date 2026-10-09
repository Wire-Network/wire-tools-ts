import { OutputFormat, QueryFailureKind } from "@wireio/ql-shared"

import { DialogOutcome, IPCChannel, type ExportWriteRequest } from "@wireio/ql-tool-app/common"
import {
  ConnectionsActions,
  ExportScope,
  QueryFiles,
  ResultsActions,
  WorkspaceActions,
  exportResults,
  openQueryFile,
  runQuery,
  saveQueryFile,
  selectActiveEditorTab
} from "@wireio/ql-tool-app/renderer/store"

import { ExecutionFixtures } from "../../../common/ExecutionFixtures.js"
import { FakeWorkbench } from "../../../common/FakeWorkbench.js"

/** A workbench whose focused result holds the positions page. */
async function withResult(): Promise<FakeWorkbench> {
  const workbench = FakeWorkbench.create()
  workbench.store.dispatch(ConnectionsActions.profilesLoaded(FakeWorkbench.profilesOf("local")))
  workbench.store.dispatch(WorkspaceActions.textChanged({ id: "editor-1", text: ExecutionFixtures.PositionsQuery }))
  workbench.queryPort.execute.mockImplementation(async ({ requestId }) => ExecutionFixtures.success(requestId))
  await workbench.store.dispatch(runQuery(false))
  return workbench
}

describe("openQueryFile / saveQueryFile", () => {
  it("a failing read or write becomes a notice, never a rejection", async () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.answers[IPCChannel.showOpenDialog] = FakeWorkbench.selected("/q/broken.sql")
    workbench.bridge.invoke.mockImplementation(async (channel: IPCChannel) => {
      if (channel === IPCChannel.readQueryFile || channel === IPCChannel.writeQueryFile) throw new Error("EACCES")
      return workbench.bridge.answers[channel]
    })
    await expect(workbench.store.dispatch(openQueryFile())).resolves.toBeUndefined()
    expect(workbench.store.getState().ui.notice).toBe(`${QueryFiles.OpenLabel} failed: EACCES`)
    workbench.bridge.answers[IPCChannel.showSaveDialog] = FakeWorkbench.selected("/q/out.sql")
    await expect(workbench.store.dispatch(saveQueryFile())).resolves.toBeUndefined()
    expect(workbench.store.getState().ui.notice).toBe(`${QueryFiles.SaveLabel} failed: EACCES`)
  })

  it("opens the chosen file into a new tab titled by its name", async () => {
    const workbench = FakeWorkbench.create()
    Object.assign(workbench.bridge.answers, {
      [IPCChannel.showOpenDialog]: FakeWorkbench.selected("/work/report.sql"),
      [IPCChannel.readQueryFile]: "SELECT 7"
    })
    await workbench.store.dispatch(openQueryFile())
    expect(selectActiveEditorTab(workbench.store.getState().workspace)).toMatchObject({
      title: "report.sql",
      text: "SELECT 7",
      filePath: "/work/report.sql"
    })
  })

  it("a cancelled open reads nothing", async () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.answers[IPCChannel.showOpenDialog] = { outcome: DialogOutcome.cancelled }
    await workbench.store.dispatch(openQueryFile())
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.readQueryFile)).toEqual([])
  })

  it("saving an untitled tab asks for a path; a cancelled save writes nothing", async () => {
    const workbench = FakeWorkbench.create()
    workbench.bridge.answers[IPCChannel.showSaveDialog] = { outcome: DialogOutcome.cancelled }
    await workbench.store.dispatch(saveQueryFile())
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.writeQueryFile)).toEqual([])
    workbench.bridge.answers[IPCChannel.showSaveDialog] = FakeWorkbench.selected("/work/new.sql")
    await workbench.store.dispatch(saveQueryFile())
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.showSaveDialog).at(-1)).toMatchObject({
      defaultName: QueryFiles.DefaultSqlName
    })
    expect(selectActiveEditorTab(workbench.store.getState().workspace).title).toBe("new.sql")
    await workbench.store.dispatch(saveQueryFile())
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.showSaveDialog)).toHaveLength(2)
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.writeQueryFile)).toHaveLength(2)
  })
})

describe("exportResults", () => {
  it("renders the loaded page as CSV and writes it to the chosen file", async () => {
    const workbench = await withResult()
    workbench.bridge.answers[IPCChannel.showSaveDialog] = FakeWorkbench.selected("/out/results.csv")
    await workbench.store.dispatch(exportResults({ format: OutputFormat.csv, scope: ExportScope.page, header: true }))
    const [written] = FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.exportWrite) as ExportWriteRequest[]
    expect(written.contents.split("\n")[0]).toContain("name")
    expect(written.contents).toContain("alice")
    expect(workbench.store.getState().ui.notice).toBe("Exported 3 rows to /out/results.csv")
  })

  it("scope all issues ONE unpaged request; its failure becomes a notice", async () => {
    const workbench = await withResult()
    workbench.bridge.answers[IPCChannel.showSaveDialog] = FakeWorkbench.selected("/out/all.json")
    workbench.queryPort.execute.mockResolvedValueOnce(ExecutionFixtures.failure("x", QueryFailureKind.transport))
    await workbench.store.dispatch(exportResults({ format: OutputFormat.json, scope: ExportScope.all, header: true }))
    expect(workbench.queryPort.execute.mock.calls.at(-1)[0]).toMatchObject({ window: { offset: 0, limit: null } })
    expect(workbench.store.getState().ui.notice).toBe(`${QueryFiles.ExportLabel} failed: JOIN is not supported`)
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.exportWrite)).toEqual([])
  })

  it("the unpaged request of an export of all rows records ONE history entry; a page export records none", async () => {
    const workbench = await withResult()
    workbench.bridge.answers[IPCChannel.showSaveDialog] = FakeWorkbench.selected("/out/all.csv")
    const before = FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyAppend).length
    await workbench.store.dispatch(exportResults({ format: OutputFormat.csv, scope: ExportScope.page, header: true }))
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyAppend)).toHaveLength(before)
    await workbench.store.dispatch(exportResults({ format: OutputFormat.csv, scope: ExportScope.all, header: true }))
    expect(FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.historyAppend)).toHaveLength(before + 1)
    expect(workbench.store.getState().ui.notice).toBe("Exported 3 rows to /out/all.csv")
  })

  it("an export applies the tab's view (hidden columns) to the rendered rows", async () => {
    const workbench = await withResult(),
      [tab] = workbench.store.getState().results.tabs
    workbench.store.dispatch(ResultsActions.viewPatched({ resultId: tab.id, patch: { hiddenColumns: ["amount"] } }))
    workbench.bridge.answers[IPCChannel.showSaveDialog] = FakeWorkbench.selected("/out/view.csv")
    await workbench.store.dispatch(exportResults({ format: OutputFormat.csv, scope: ExportScope.page, header: true }))
    const [written] = FakeWorkbench.requestsOf(workbench.bridge, IPCChannel.exportWrite) as ExportWriteRequest[]
    expect(written.contents.split(/\r?\n/)[0]).toBe("name,balance")
  })

  it("nothing to export without a successful result", async () => {
    const workbench = FakeWorkbench.create()
    await workbench.store.dispatch(exportResults({ format: OutputFormat.csv, scope: ExportScope.page, header: true }))
    expect(workbench.bridge.invoke).not.toHaveBeenCalled()
  })
})
