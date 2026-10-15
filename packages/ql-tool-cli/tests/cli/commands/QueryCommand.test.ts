import Fs from "node:fs"
import Path from "node:path"

import { JsonRPCProtocol, ProcessSignalName } from "@wireio/cluster-tool-shared"
import { getLoggingManager, Level } from "@wireio/shared"
import { OutputFormat, QueryErrorKind, QueryOutcome, ResultSummary } from "@wireio/ql-shared"

import { QLExitCode, QueryCommand, resolveOutputArgs } from "@wireio/ql-tool-cli/cli/index.js"

import { sampleResult, successExecution } from "../../common/engineFixtures.js"
import { runWql } from "../../common/runWql.js"
import { useStubEngine, unusedEndpoint } from "../../common/stubEngine.js"
import { createTestContext } from "../../common/testContext.js"

/** The tail of the `--show-stats` line (scanned / matched / server µs). */
const StatsLineMarker = " · scanned 3 · matched 3 · 900 µs"
/** The head of the `--show-state` line. */
const StateLineMarker = "block 42 "

describe("wql [query] against a stub engine", () => {

  const engine = useStubEngine()

  beforeEach(() => {
    engine().requests.length = 0
    engine().respondWith(() => ({ jsonrpc: JsonRPCProtocol.Version, result: sampleResult() }))
  })

  it("sends page 1 of 100 by default and prints a table with the page footer", async () => {
    const { context } = createTestContext(),
      run = await runWql(["-u", engine().endpoint, "SELECT * FROM sample.positions"], context)
    expect(run.exitCode).toBe(QLExitCode.success)
    expect(engine().requests[0].params).toEqual({ query: "SELECT * FROM sample.positions", limit: 100, offset: 0 })
    expect(run.stdout.join("\n")).toContain("alice")
    expect(run.stdout.join("\n")).toContain("page 1/1 · rows 1–3 of 3 · block 42")
    expect(context.historyStore.list()[0]).toMatchObject({ outcome: QueryOutcome.success, returnedRows: 3 })
  })

  it("sends no limit with --all, the pager window with --page/--page-size, the exact --offset/--limit", async () => {
    const { context } = createTestContext()
    await runWql(["-u", engine().endpoint, "--all", "SELECT 1"], context)
    await runWql(["-u", engine().endpoint, "--page", "3", "--page-size", "50", "SELECT 1"], context)
    await runWql(["-u", engine().endpoint, "--offset", "7", "--limit", "3", "--timeout-ms", "400", "SELECT 1"], context)
    expect(engine().requests.map(request => request.params)).toEqual([
      { query: "SELECT 1", offset: 0 },
      { query: "SELECT 1", limit: 50, offset: 100 },
      { query: "SELECT 1", limit: 3, offset: 7, timeout_ms: 400 }
    ])
  })

  it("writes --format json to --output-file and hints the next page when the server has more", async () => {
    engine().respondWith(() => ({ jsonrpc: JsonRPCProtocol.Version, result: sampleResult({ total: 10, hasMore: true }) }))
    const { context, directory } = createTestContext(),
      file = Path.join(directory, "out.json"),
      run = await runWql(["-u", engine().endpoint, "-o", file, "SELECT 1"], context)
    expect(run.exitCode).toBe(QLExitCode.success)
    expect(JSON.parse(Fs.readFileSync(file, "utf8"))).toHaveLength(3)
    expect(run.stderr).toContain("more rows: --page 2")
  })

  it("applies --sort/--filter/--columns to the loaded page", async () => {
    const { context } = createTestContext(),
      run = await runWql(["-u", engine().endpoint, "SELECT 1", "-f", "csv", "--sort", "id:desc", "--filter", "name=a", "--columns", "name"], context)
    expect(run.stdout.join("\n")).toBe("name\ncarol\nalice")
  })

  it("--show-stats appends the stats line, --show-state the block snapshot; both are absent by default", async () => {
    const { context } = createTestContext(),
      plain = (await runWql(["-u", engine().endpoint, "SELECT 1"], context)).stdout.join("\n"),
      withStats = (await runWql(["-u", engine().endpoint, "--show-stats", "SELECT 1"], context)).stdout.join("\n"),
      withState = (await runWql(["-u", engine().endpoint, "--show-state", "SELECT 1"], context)).stdout.join("\n")
    expect(plain).not.toContain(StatsLineMarker)
    expect(plain).not.toContain(StateLineMarker)
    expect(withStats).toContain(`rows 1–3 of 3${StatsLineMarker}`)
    expect(withStats).not.toContain(StateLineMarker)
    expect(withState).toContain(`block 42 · ${"a".repeat(64)} · 2026-09-21T12:00:00.000 · head · LIB 40 · synced`)
    expect(withState).not.toContain(StatsLineMarker)
  })

  it("--no-header omits the header row of table and csv output; the default keeps it", async () => {
    const { context } = createTestContext(),
      table = (await runWql(["-u", engine().endpoint, "SELECT 1"], context)).stdout,
      bareTable = (await runWql(["-u", engine().endpoint, "--no-header", "SELECT 1"], context)).stdout,
      csv = (await runWql(["-u", engine().endpoint, "-f", "csv", "SELECT 1"], context)).stdout.join("\n"),
      bareCsv = (await runWql(["-u", engine().endpoint, "-f", "csv", "--no-header", "SELECT 1"], context)).stdout.join("\n")
    expect(table.some(line => /\bid\b.*\bname\b/.test(line))).toBe(true)
    expect(bareTable.some(line => /\bid\b.*\bname\b/.test(line))).toBe(false)
    expect(bareTable.join("\n")).toContain("alice")
    expect(csv).toBe("id,name\n1,alice\n2,bob\n3,carol")
    expect(bareCsv).toBe("1,alice\n2,bob\n3,carol")
  })

  it("exits with the engine kind's code, prints a caret, and records the failure", async () => {
    engine().respondWith(() => ({
      jsonrpc: JsonRPCProtocol.Version,
      error: { code: -32010, message: "unexpected JOIN", data: { kind: "QUERY_SYNTAX", retryable: false, line: 1, column: 19, limit: null } }
    }))
    const { context } = createTestContext(),
      run = await runWql(["-u", engine().endpoint, "SELECT * FROM a.b JOIN c.d"], context)
    expect(run.exitCode).toBe(QLExitCode.querySyntax)
    expect(run.stderr[0]).toBe("error: QUERY_SYNTAX: unexpected JOIN")
    expect(run.stderr[2]).toContain("^^^^")
    expect(context.historyStore.list()[0]).toMatchObject({ outcome: QueryOutcome.engineError, errorKind: QueryErrorKind.QUERY_SYNTAX })
  })

  it("exits 3 on a transport failure and 2 on usage errors without sending", async () => {
    const { context } = createTestContext()
    expect((await runWql(["-u", await unusedEndpoint(), "SELECT 1"], context)).exitCode).toBe(QLExitCode.transport)
    const usage = createTestContext().context
    expect((await runWql(["-u", engine().endpoint, "--all", "--page", "2", "SELECT 1"], usage)).exitCode).toBe(QLExitCode.usage)
    expect((await runWql(["-u", engine().endpoint, "--bogus", "SELECT 1"], createTestContext().context)).exitCode).toBe(QLExitCode.usage)
    expect((await runWql(["SELECT 1"], createTestContext().context)).exitCode).toBe(QLExitCode.usage)
    expect(engine().requests).toEqual([])
  })

  it("sets the diagnostic root level from --log-level", async () => {
    const levels: string[] = [],
      { context } = createTestContext(),
      original = getLoggingManager().setRootLevel.bind(getLoggingManager())
    jest.spyOn(getLoggingManager(), "setRootLevel").mockImplementation(level => {
      levels.push(level)
      return original(level)
    })
    await runWql(["-u", engine().endpoint, "--log-level", "debug", "SELECT 1"], context)
    await runWql(["-u", engine().endpoint, "SELECT 1"], context)
    expect(levels.filter(level => level !== Level.info)).toEqual([Level.debug, Level.error])
    jest.restoreAllMocks()
  })
})

describe("QueryCommand helpers", () => {
  it("page footer (ResultSummary.describe over the output window): pager, all and empty pages", () => {
    const pager = resolveOutputArgs({ page: 2, pageSize: 2 }),
      execution = successExecution(sampleResult({ offset: 2, total: 5 }))
    expect(ResultSummary.describe(execution.result, pager.window.limit)).toBe("page 2/3 · rows 3–5 of 5 · block 42")
    expect(ResultSummary.describe(sampleResult(), resolveOutputArgs({ all: true }).window.limit)).toBe(
      "page 1/1 · rows 1–3 of 3 · block 42"
    )
    expect(ResultSummary.describe({ ...sampleResult({ total: 0 }), rows: [], page: { ...sampleResult().page, returned_rows: "0", total_rows: "0" } }, pager.window.limit)).toContain(
      "rows 0 of 0"
    )
  })

  it("nextPageHint: --page for pager windows, --offset for explicit windows, none without more rows", () => {
    const more = successExecution(sampleResult({ offset: 0, total: 9, hasMore: true }))
    expect(QueryCommand.nextPageHint(more, resolveOutputArgs({}))).toBe("more rows: --page 2")
    expect(QueryCommand.nextPageHint(more, resolveOutputArgs({ limit: 3 }))).toBe("more rows: --offset 3")
    expect(QueryCommand.nextPageHint(successExecution(), resolveOutputArgs({}))).toBeUndefined()
  })

  it("run → 130 when SIGINT abandons the request", async () => {
    const { context } = createTestContext({
        clientOptions: {
          fetchProvider: (_url, init) =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => reject(new Error("aborted")))
              setImmediate(() => process.emit(ProcessSignalName.SIGINT))
            })
        }
      }),
      profile = context.resolveProfile({ url: "http://node.example" }),
      exit = await QueryCommand.run(context, { query: "SELECT 1", profile, output: resolveOutputArgs({ format: OutputFormat.json }) })
    expect(exit).toBe(QLExitCode.interrupted)
  })
})
