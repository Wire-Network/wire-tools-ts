import {
  CellWidthMode,
  createRenderDefaultOptions,
  LogicalType,
  OutputFormat,
  ResultRenderer,
  ResultView,
  type RenderInput
} from "@wireio/ql-shared"

import { column, createResult, createSuccess, Hash64 } from "../common/resultFixtures.js"

const columns = [column("name", LogicalType.text), column("amount", LogicalType.integer), column("note", LogicalType.text)],
  rows = [
    { name: "a,b", amount: "5", note: "x|y\n<z>&\"q\"" },
    { name: "漢字", amount: "-12", note: null }
  ],
  input = (options: Parameters<typeof ResultView.create>[1] = {}): RenderInput => {
    const result = createResult(columns, rows),
      view = ResultView.create(result, options)
    return { execution: createSuccess(result), view, range: view.fullRange() }
  }

describe("ResultRenderer", () => {
  it("table: box drawing, display-width alignment, right-aligned numbers, escaped controls", () => {
    expect(ResultRenderer.render(OutputFormat.table, input())).toBe(
      [
        "┌──────┬────────┬─────────────┐",
        "│ name │ amount │ note        │",
        "├──────┼────────┼─────────────┤",
        "│ a,b  │      5 │ x|y␊<z>&\"q\" │",
        "│ 漢字 │    -12 │ NULL        │",
        "└──────┴────────┴─────────────┘",
        ""
      ].join("\n")
    )
  })

  it("table: no header, truncation, color and summary lines", () => {
    const text = ResultRenderer.render(OutputFormat.table, input(), {
      header: false,
      maxCellWidth: 4,
      cellWidthMode: CellWidthMode.truncated,
      color: true,
      showStats: true,
      showState: true
    })
    expect(text).not.toContain("amount")
    expect(text).toContain("x|y…")
    expect(text).toContain("\u001b[2mNULL\u001b[0m")
    expect(text).toContain("rows 1–2 of 2 · scanned 2 · matched 2 · 1200 µs server · 12.5 ms wall")
    expect(text).toContain(`block 42 · ${Hash64} · 2026-09-21T12:00:00.000 · head · LIB 40 · synced`)
    expect(ResultRenderer.render(OutputFormat.table, input(), { cellWidthMode: CellWidthMode.full })).toContain("x|y␊<z>&\"q\"")
  })

  it("json: rows, or rows + page/stats/state", () => {
    expect(JSON.parse(ResultRenderer.render(OutputFormat.json, input({ columns: ["name"] })))).toEqual([{ name: "a,b" }, { name: "漢字" }])
    const document = JSON.parse(ResultRenderer.render(OutputFormat.json, input(), { showStats: true, showState: true }))
    expect(Object.keys(document)).toEqual(["rows", "page", "stats", "state"])
    expect(Object.keys(JSON.parse(ResultRenderer.render(OutputFormat.json, input(), { showStats: true })))).toEqual(["rows", "page", "stats"])
  })

  it("jsonl: one object per line", () => {
    expect(ResultRenderer.render(OutputFormat.jsonl, input({ columns: ["amount"] }))).toBe("{\"amount\":\"5\"}\n{\"amount\":\"-12\"}\n")
  })

  it("csv: RFC 4180 quoting, NULL empty, optional header", () => {
    expect(ResultRenderer.render(OutputFormat.csv, input())).toBe(
      "name,amount,note\n\"a,b\",5,\"x|y\n<z>&\"\"q\"\"\"\n漢字,-12,\n"
    )
    expect(ResultRenderer.render(OutputFormat.csv, input({ columns: ["amount"] }), { header: false })).toBe("5\n-12\n")
  })

  it("tsv: backslash escapes, NULL as \\N", () => {
    expect(ResultRenderer.render(OutputFormat.tsv, input())).toBe("name\tamount\tnote\na,b\t5\tx|y\\n<z>&\"q\"\n漢字\t-12\t\\N\n")
  })

  it("markdown: escaped pipes and newlines, numeric alignment, summary", () => {
    expect(ResultRenderer.render(OutputFormat.markdown, input())).toBe(
      "| name | amount | note |\n| --- | ---: | --- |\n| a,b | 5 | x\\|y<br>&lt;z&gt;&amp;&quot;q&quot; |\n| 漢字 | -12 | <i>NULL</i> |\n"
    )
    expect(ResultRenderer.render(OutputFormat.markdown, input(), { showStats: true })).toContain("\n\nrows 1–2 of 2 · scanned 2")
  })

  it("markdown: a NULL cell is distinct from the text NULL; raw < in text is always an entity", () => {
    const result = createResult([column("t", LogicalType.text)], [{ t: "NULL" }, { t: null }, { t: "<i>NULL</i>\r\nx" }]),
      view = ResultView.create(result),
      text = ResultRenderer.render(OutputFormat.markdown, { execution: createSuccess(result), view, range: view.fullRange() })
    expect(text.split("\n").slice(2, 5)).toEqual(["| NULL |", "| <i>NULL</i> |", "| &lt;i&gt;NULL&lt;/i&gt;<br>x |"])
  })

  it("table: truncation keeps the longest fitting prefix (no narrow character after a wide one)", () => {
    const result = createResult([column("t", LogicalType.text)], [{ t: "abc中d" }, { t: "ab中" }]),
      view = ResultView.create(result),
      text = ResultRenderer.render(OutputFormat.table, { execution: createSuccess(result), view, range: view.fullRange() }, { maxCellWidth: 5, header: false })
    expect(text).toContain("│ abc… │")
    expect(text).not.toContain("abcd")
    expect(text).toContain("│ ab中 │")
  })

  it("rejects a view that is not over the execution's result", () => {
    const view = ResultView.create(createResult(columns, rows))
    expect(() =>
      ResultRenderer.render(OutputFormat.csv, { execution: createSuccess(createResult(columns, rows)), view, range: view.fullRange() })
    ).toThrow("not over the execution's result")
  })

  it("html: thead and entity escaping", () => {
    const html = ResultRenderer.render(OutputFormat.html, input())
    expect(html).toContain("<thead>")
    expect(html).toContain("<td>x|y\n&lt;z&gt;&amp;&quot;q&quot;</td>")
    expect(html).toContain("<td class=\"null\"></td>")
    expect(ResultRenderer.render(OutputFormat.html, input(), { header: false })).not.toContain("<thead>")
  })

  it("summary lines: stats then state, built from the ResultSummary parts; an unsynced node says so", () => {
    const result = createResult(columns, rows),
      unsynced = { ...result, state: { ...result.state, synced: false } },
      view = ResultView.create(unsynced),
      text = ResultRenderer.render(
        OutputFormat.table,
        { execution: createSuccess(unsynced), view, range: view.fullRange() },
        { showStats: true, showState: true }
      ),
      [statsLine, stateLine] = text.trimEnd().split("\n").slice(-2)
    expect(statsLine).toBe("rows 1–2 of 2 · scanned 2 · matched 2 · 1200 µs server · 12.5 ms wall")
    expect(stateLine).toBe(`block 42 · ${Hash64} · 2026-09-21T12:00:00.000 · head · LIB 40 · NOT synced`)
    expect(ResultRenderer.render(OutputFormat.table, input(), { showState: true })).not.toContain("scanned")
  })

  it("html / xml / markdown escape apostrophes as entities (lodash escape)", () => {
    const result = createResult([column("t", LogicalType.text)], [{ t: "it's" }]),
      view = ResultView.create(result),
      render = (format: OutputFormat) => ResultRenderer.render(format, { execution: createSuccess(result), view, range: view.fullRange() })
    expect(render(OutputFormat.html)).toContain("<td>it&#39;s</td>")
    expect(render(OutputFormat.xml)).toContain("<column name=\"t\">it&#39;s</column>")
    expect(render(OutputFormat.markdown)).toContain("| it&#39;s |")
  })

  it("xml: escaped values and null markers", () => {
    const xml = ResultRenderer.render(OutputFormat.xml, input())
    expect(xml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<result>\n  <row>\n")).toBe(true)
    expect(xml).toContain("<column name=\"note\">x|y\n&lt;z&gt;&amp;&quot;q&quot;</column>")
    expect(xml).toContain("<column name=\"note\" null=\"true\"/>")
  })

  it("raw: the engine result verbatim, ignoring the client view", () => {
    const raw = JSON.parse(ResultRenderer.render(OutputFormat.raw, input({ columns: ["name"] })))
    expect(raw.columns).toHaveLength(3)
    expect(raw.page).toBeDefined()
  })

  it("maps file names to formats and formats to extensions", () => {
    expect(ResultRenderer.formatForFile("/tmp/out.CSV")).toBe(OutputFormat.csv)
    expect(ResultRenderer.formatForFile("out.json")).toBe(OutputFormat.json)
    expect(ResultRenderer.formatForFile("out.md")).toBe(OutputFormat.markdown)
    expect(ResultRenderer.fileExtension(OutputFormat.raw)).toBe("json")
    expect(ResultRenderer.fileExtension(OutputFormat.table)).toBe("txt")
    ;[OutputFormat.json, OutputFormat.jsonl, OutputFormat.csv, OutputFormat.tsv, OutputFormat.html, OutputFormat.xml].forEach(format =>
      expect(ResultRenderer.fileExtension(format)).toBe(format)
    )
    expect(() => ResultRenderer.formatForFile("out.parquet")).toThrow("no output format")
    expect(() => ResultRenderer.formatForFile("noextension")).toThrow()
  })

  it("has documented defaults", () => {
    expect(createRenderDefaultOptions()).toEqual({
      header: true,
      showStats: false,
      showState: false,
      color: false,
      cellWidthMode: CellWidthMode.truncated,
      maxCellWidth: ResultRenderer.DefaultMaxCellWidth
    })
  })
})
