import { act } from "react"
import { useWindowSize } from "ink"

import { JsonRPCProtocol } from "@wireio/cluster-tool-shared"

import {
  CatalogService,
  FocusArea,
  KeyScope,
  PromptKind,
  QueryRunStatus,
  ResultsActions,
  ResultsTab,
  StatusBar,
  TuiModal,
  TuiServiceId,
  WorkbenchRoute
} from "@wireio/ql-tool-cli/tui/index.js"

import { sampleResult } from "../../common/engineFixtures.js"
import { inkMock, press, renderTui, textOf } from "../../common/renderTui.js"
import { useStubEngine } from "../../common/stubEngine.js"
import { idle, startTuiHarness, type TuiHarness } from "../../common/tuiHarness.js"
import { waitFor } from "../../common/waitFor.js"

/** OSC 52 clipboard prefix (ESC ] 52 ; c ;). */
const ClipboardPrefix = "\u001b]52;c;"
/** OSC 52 terminator (BEL). */
const ClipboardSuffix = "\u0007"

describe("WorkbenchRoute", () => {
  let harness: TuiHarness

  const engine = useStubEngine()

  beforeEach(async () => {
    engine().requests.length = 0
    engine().respondWith(() => ({ jsonrpc: JsonRPCProtocol.Version, result: sampleResult({ total: 300, hasMore: true }) }))
    harness = await startTuiHarness(engine().endpoint)
    await harness.registry.get<CatalogService>(TuiServiceId.catalog).loading
  })

  afterEach(async () => {
    // The mocked terminal size returns to the jest.setup.ts default after a test shrinks it.
    jest.mocked(useWindowSize).mockReturnValue({ columns: 120, rows: 40 })
    await harness.registry.stopAll()
  })

  const render = () => renderTui(<WorkbenchRoute />, { store: harness.store, registry: harness.registry }),
    state = () => harness.store.getState(),
    type = (text: string) => Array.from(text).forEach(character => press(character))

  it("types SQL in the editor, runs it with Ctrl+R and shows the grid", async () => {
    const renderer = render()
    type("SELECT 1")
    press("r", { ctrl: true })
    await idle(harness)
    expect(engine().requests[0].params).toEqual({ query: "SELECT 1", limit: 100, offset: 0 })
    expect(state().results.status).toBe(QueryRunStatus.succeeded)
    expect(textOf(renderer)).toContain("carol")
    expect(textOf(renderer)).toContain("page 1/3 (size 100)")
  })

  it("grid keys: move, sort, page, page size, filter prompt, find, inspect, copy", async () => {
    render()
    type("SELECT 1")
    press("r", { ctrl: true })
    await idle(harness)
    press("", { tab: true })
    expect(state().ui.focus).toBe(FocusArea.grid)
    press("", { downArrow: true })
    press("", { rightArrow: true })
    expect(state().results).toMatchObject({ cursorRow: 1, cursorColumn: 1 })
    press("s")
    expect(state().results.sorts).toEqual([{ column: "name", direction: "asc" }])
    press("", { pageDown: true })
    await idle(harness)
    expect(engine().requests.at(-1).params).toMatchObject({ offset: 100 })
    press("", { end: true })
    await idle(harness)
    expect(engine().requests.at(-1).params).toMatchObject({ offset: 200 })
    press("", { pageUp: true })
    press("", { home: true })
    await idle(harness)
    expect(engine().requests.at(-1).params).toMatchObject({ offset: 0 })
    press("z")
    await idle(harness)
    expect(engine().requests.at(-1).params).toMatchObject({ limit: 500, offset: 0 })
    press("f")
    expect(state().ui).toMatchObject({ modal: TuiModal.prompt, prompt: expect.objectContaining({ kind: PromptKind.filter, column: "name" }) })
    press("o")
    press("", { return: true })
    expect(state().results.filters).toEqual([{ column: "name", text: "o" }])
    press("/")
    expect(state().ui.modal).toBe(TuiModal.find)
    press("", { escape: true })
    press("i")
    expect(state().ui.modal).toBe(TuiModal.inspector)
    press("", { escape: true })
    press("y")
    const [written] = inkMock().__write.mock.calls.at(-1)
    expect(written.startsWith(ClipboardPrefix) && written.endsWith(ClipboardSuffix)).toBe(true)
    expect(Buffer.from(written.slice(ClipboardPrefix.length, -ClipboardSuffix.length), "base64").toString("utf8")).toBe("2\tbob")
  })

  it("global keys: JSON / record tabs, format, save prompt, window prompt, export guard, cancel", async () => {
    render()
    type("select id from a.b")
    press("f", { meta: true })
    expect(state().editor.buffer.text).toBe("SELECT id\nFROM a.b")
    press("j", { meta: true })
    expect(state().ui.tab).toBe(ResultsTab.json)
    press("v", { meta: true })
    expect(state().ui.tab).toBe(ResultsTab.record)
    press("e", { meta: true })
    expect(state().ui.messages.at(-1).text).toMatch(/nothing to export/)
    press("w", { meta: true })
    type("mine")
    press("", { return: true })
    expect(state().saved.items.map(saved => saved.name)).toEqual(["mine"])
    press("l", { meta: true })
    type("5,2")
    press("", { return: true })
    await idle(harness)
    expect(state().results.window).toEqual({ offset: 5, limit: 2 })
    press("", { escape: true })
    expect(state().ui.modal).toBe(TuiModal.none)
  })

  it("JSON tab ↑↓ scroll its lines (not the grid cursor); z clears an Alt+L window; copy names the clamped row", async () => {
    jest.mocked(useWindowSize).mockReturnValue({ columns: 120, rows: 24 })
    render()
    type("SELECT 1")
    press("r", { ctrl: true })
    await idle(harness)
    press("", { tab: true })
    press("j", { meta: true })
    press("", { downArrow: true })
    press("", { downArrow: true })
    expect(state().results).toMatchObject({ jsonLine: 2, cursorRow: 0 })
    press("", { upArrow: true })
    expect(state().results.jsonLine).toBe(1)
    press("j", { meta: true })
    press("l", { meta: true })
    type("0,2")
    press("", { return: true })
    await idle(harness)
    expect(state().results.window).toEqual({ offset: 0, limit: 2 })
    press("z")
    await idle(harness)
    expect(state().results.window).toBeNull()
    act(() => void harness.store.dispatch(ResultsActions.cursorPlaced(99)))
    press("y")
    expect(state().ui.messages.at(-1).text).toBe("copied row 3 (TSV)")
  })

  it("an unparsable query is reported by Alt+F; bad window / empty save name are warned", () => {
    render()
    type("SELECT FROM")
    press("f", { meta: true })
    expect(state().editor.buffer.text).toBe("SELECT FROM")
    press("l", { meta: true })
    type("x")
    press("", { return: true })
    press("w", { meta: true })
    press("", { return: true })
    expect(state().ui.messages.map(message => message.text)).toEqual(
      expect.arrayContaining([expect.stringMatching(/does not parse/), 'not a window: "x" (expected offset,limit)', "a saved query needs a name"])
    )
  })

  it("schema keys: expand an owner, insert a qualified table, describe", async () => {
    render()
    press("", { tab: true, shift: true })
    expect(state().ui.focus).toBe(FocusArea.schema)
    press("", { return: true })
    press("", { downArrow: true })
    press("", { rightArrow: true })
    press("", { return: true })
    expect(state().editor.buffer.text).toBe("sample.positions")
    press("d")
    await waitFor(() => engine().requests.length > 0)
    expect(engine().requests.at(-1).params).toMatchObject({ limit: 0 })
    press("", { upArrow: true })
    expect(state().catalog.cursor).toBe(0)
  })

  it("c opens the column chooser over a result (warned before a run); the grid shows only visible columns", async () => {
    const renderer = render()
    press("", { tab: true })
    press("c")
    expect(state().ui.modal).toBe(TuiModal.none)
    expect(state().ui.messages.at(-1).text).toMatch(/no columns to choose/)
    press("", { tab: true })
    press("", { tab: true })
    type("SELECT 1")
    press("r", { ctrl: true })
    await idle(harness)
    press("", { tab: true })
    press("c")
    expect(state().ui.modal).toBe(TuiModal.columns)
    press("", { downArrow: true })
    press(" ")
    press("", { return: true })
    expect(state().results.hiddenColumns).toEqual(["name"])
    expect(textOf(renderer)).not.toContain("carol")
  })

  it("Alt+R retries a retryable failure with the same window; the status bar says retryable", async () => {
    engine().respondWith(() => ({
      jsonrpc: JsonRPCProtocol.Version,
      error: { code: -32014, message: "busy", data: { kind: "QUERY_BUSY", retryable: true, line: null, column: null, limit: null } }
    }))
    const renderer = render()
    type("SELECT 1")
    press("r", { ctrl: true })
    await idle(harness)
    expect(textOf(renderer)).toContain(StatusBar.RetryableText)
    engine().respondWith(() => ({ jsonrpc: JsonRPCProtocol.Version, result: sampleResult({ total: 300, hasMore: true }) }))
    press("r", { meta: true })
    await idle(harness)
    expect(engine().requests.map(request => request.params)).toEqual([
      { query: "SELECT 1", limit: 100, offset: 0 },
      { query: "SELECT 1", limit: 100, offset: 0 }
    ])
    expect(state().results.status).toBe(QueryRunStatus.succeeded)
    press("r", { meta: true })
    await idle(harness)
    expect(engine().requests).toHaveLength(2)
  })

  it("navigation keys push routes (shown in the header)", () => {
    const renderer = render()
    press("h", { meta: true })
    expect(textOf(renderer)).toContain("· history")
  })

  it("scopeFor maps focus to key scope", () => {
    expect(WorkbenchRoute.scopeFor(FocusArea.editor)).toBe(KeyScope.editor)
    expect(WorkbenchRoute.scopeFor(FocusArea.grid)).toBe(KeyScope.grid)
    expect(WorkbenchRoute.scopeFor(FocusArea.schema)).toBe(KeyScope.global)
    act(() => undefined)
  })
})

describe("WorkbenchRoute messages", () => {
  it("names its prompt titles and warnings", () => {
    expect(WorkbenchRoute.SaveQueryTitle).toBe("Save the query as")
    expect(WorkbenchRoute.WindowPromptTitle).toBe("Server window: offset,limit (empty = page size / page)")
    expect(WorkbenchRoute.NoColumnsText).toMatch(/run a query first/)
    expect(WorkbenchRoute.UnnamedSavedQueryText).toBe("a saved query needs a name")
  })

  it("builds the templated messages", () => {
    expect(WorkbenchRoute.filterTitle("id")).toBe("Filter id (contains; this page; empty clears)")
    expect(WorkbenchRoute.notWindowText("1,2,3")).toBe('not a window: "1,2,3" (expected offset,limit)')
    expect(WorkbenchRoute.formatFailedText(new Error("boom"))).toBe("format failed: boom")
    expect(WorkbenchRoute.copiedRowText(0)).toBe("copied row 1 (TSV)")
  })
})
