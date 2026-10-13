import Fs from "node:fs"
import Path from "node:path"

import { JsonRPCProtocol } from "@wireio/cluster-tool-shared"
import { OutputFormat, QueryErrorKind, QueryOutcome } from "@wireio/ql-shared"

import {
  CatalogService,
  EditorActions,
  ExportScope,
  QueryRunStatus,
  QueryService,
  ResultsActions,
  TuiServiceId
} from "@wireio/ql-tool-cli/tui/index.js"

import { sampleResult, successExecution, engineFailureExecution } from "../../common/engineFixtures.js"
import { HoldResponse, useStubEngine } from "../../common/stubEngine.js"
import { startTuiHarness, type TuiHarness } from "../../common/tuiHarness.js"

describe("QueryService", () => {
  let harness: TuiHarness

  const engine = useStubEngine()

  beforeEach(async () => {
    engine().requests.length = 0
    engine().respondWith(() => ({ jsonrpc: JsonRPCProtocol.Version, result: sampleResult({ total: 250, hasMore: true }) }))
    harness = await startTuiHarness(engine().endpoint)
  })

  afterEach(() => harness.registry.stopAll())

  const service = () => harness.registry.get<QueryService>(TuiServiceId.query)

  it("runs the editor text from page 1, publishes the result, records history and a message", async () => {
    harness.store.dispatch(EditorActions.textReplaced("SELECT * FROM sample.positions"))
    await service().run()
    const { results, history, ui } = harness.store.getState()
    expect(results.status).toBe(QueryRunStatus.succeeded)
    expect(engine().requests[0].params).toEqual({ query: "SELECT * FROM sample.positions", limit: 100, offset: 0 })
    expect(history.items[0]).toMatchObject({ outcome: QueryOutcome.success })
    expect(ui.messages.at(-1).text).toMatch(/^rows 1–3 of 250 · block 42 · 900 µs server · [\d.]+ ms wall$/)
  })

  it("fetches pages of the LAST run (clamped) and honors an explicit window", async () => {
    await service().run("SELECT 1")
    harness.store.dispatch(EditorActions.textReplaced("SELECT edited"))
    await service().fetchPage(9)
    expect(engine().requests.at(-1).params).toEqual({ query: "SELECT 1", limit: 100, offset: 200 })
    harness.store.dispatch(ResultsActions.windowSet({ offset: 5, limit: 2 }))
    await service().fetchPage(1)
    expect(engine().requests.at(-1).params).toEqual({ query: "SELECT 1", limit: 2, offset: 5 })
  })

  it("does nothing for an empty query or paging before a run", async () => {
    await service().run("   ")
    await service().fetchPage(2)
    expect(engine().requests).toEqual([])
    expect(harness.store.getState().ui.messages.at(-1).text).toBe("the query is empty")
  })

  it("reports failures; SCHEMA_CHANGED invalidates the catalog", async () => {
    engine().respondWith(() => ({ jsonrpc: JsonRPCProtocol.Version, error: { code: -32015, message: "abi changed", data: { kind: "SCHEMA_CHANGED", retryable: false, line: null, column: null, limit: null } } }))
    const invalidate = jest.spyOn(harness.registry.get<CatalogService>(TuiServiceId.catalog), "invalidate")
    await service().run("SELECT 1")
    expect(harness.store.getState().results.status).toBe(QueryRunStatus.failed)
    expect(invalidate).toHaveBeenCalled()
    expect(harness.store.getState().ui.messages.at(-1).text).toMatch(/SCHEMA_CHANGED: abi changed/)
  })

  it("cancel abandons the in-flight run (recorded as cancelled); a new run supersedes the old", async () => {
    engine().respondWith(() => HoldResponse)
    const { registry, store } = harness,
      query = registry.get<QueryService>(TuiServiceId.query),
      running = query.run("SELECT 1")
    expect(query.busy).toBe(true)
    query.cancel()
    await running
    expect(store.getState().history.items[0].outcome).toBe(QueryOutcome.cancelled)
    expect(query.busy).toBe(false)
  })

  it("exports the page (with the client view) and all rows (one unlimited request)", async () => {
    await service().run("SELECT 1")
    harness.store.dispatch(ResultsActions.filterSet({ column: "name", text: "o" }))
    const pageFile = await service().exportResult({ format: OutputFormat.csv, scope: ExportScope.page, header: true, file: Path.join(harness.context.profileStore.file, "..", "page.csv") })
    expect(Fs.readFileSync(pageFile, "utf8")).toBe("id,name\n2,bob\n3,carol\n")
    await service().exportResult({ format: OutputFormat.json, scope: ExportScope.all, header: false, file: Path.join(harness.context.profileStore.file, "..", "all.json") })
    expect(engine().requests.at(-1).params).toEqual({ query: "SELECT 1", offset: 0 })
  })

  it("refuses to export before a run, and when the all-rows request fails", async () => {
    await expect(service().exportResult({ format: OutputFormat.csv, scope: ExportScope.page, header: true, file: "/tmp/never.csv" })).rejects.toThrow(QueryService.NothingToExportText)
    expect(() => QueryService.assertSuccess(engineFailureExecution(QueryErrorKind.QUERY_LIMIT))).toThrow(/query failed/)
    expect(QueryService.assertSuccess(successExecution()).status).toBe("success")
    expect(QueryService.summary(successExecution())).toContain("block 42")
  })

  it("Retry re-sends the failed query with the same page / window and says so", async () => {
    const busyError = { code: -32014, message: "busy", data: { kind: "QUERY_BUSY", retryable: true, line: null, column: null, limit: null } }
    await service().run("SELECT 1")
    await service().fetchPage(2)
    engine().respondWith(() => ({ jsonrpc: JsonRPCProtocol.Version, error: busyError }))
    await service().fetchPage(3)
    expect(harness.store.getState().ui.messages.at(-1).text).toBe(QueryService.RetryableText)
    engine().respondWith(() => ({ jsonrpc: JsonRPCProtocol.Version, result: sampleResult({ total: 250, hasMore: true }) }))
    harness.store.dispatch(EditorActions.textReplaced("SELECT edited"))
    await service().retry()
    expect(engine().requests.at(-1).params).toEqual({ query: "SELECT 1", limit: 100, offset: 200 })
    expect(harness.store.getState().results).toMatchObject({ status: QueryRunStatus.succeeded, page: 3 })
  })

  it("Retry without a retryable failure warns and sends nothing", async () => {
    await service().retry()
    expect(engine().requests).toEqual([])
    expect(harness.store.getState().ui.messages.at(-1).text).toBe(QueryService.NotRetryableText)
    engine().respondWith(() => ({ jsonrpc: JsonRPCProtocol.Version, error: { code: -32010, message: "bad", data: { kind: "QUERY_SYNTAX", retryable: false, line: 1, column: 1, limit: null } } }))
    await service().run("SELECT 1")
    expect(harness.store.getState().ui.messages.map(message => message.text)).not.toContain(QueryService.RetryableText)
    await service().retry()
    expect(engine().requests).toHaveLength(1)
  })

  it("page and all-rows exports honor the hidden columns", async () => {
    await service().run("SELECT 1")
    harness.store.dispatch(ResultsActions.columnToggled("id"))
    const directory = Path.join(harness.context.profileStore.file, ".."),
      pageFile = await service().exportResult({ format: OutputFormat.csv, scope: ExportScope.page, header: true, file: Path.join(directory, "projected.csv") }),
      allFile = await service().exportResult({ format: OutputFormat.csv, scope: ExportScope.all, header: false, file: Path.join(directory, "projected-all.csv") })
    expect(Fs.readFileSync(pageFile, "utf8")).toBe("name\nalice\nbob\ncarol\n")
    expect(Fs.readFileSync(allFile, "utf8")).toBe("alice\nbob\ncarol\n")
  })
})
