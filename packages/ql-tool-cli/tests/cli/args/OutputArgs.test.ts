import Yargs from "yargs"

import { declaredDefaults } from "../../common/yargsIntrospection.js"

import { CellWidthMode, OutputFormat, PageSizeMode, QueryPager, SortDirection } from "@wireio/ql-shared"

import {
  applyOutputArgs,
  createOutputDefaultOptions,
  OutputArgs,
  OutputWindowSource,
  QLUsageError,
  resolveOutputArgs,
  type OutputOptions
} from "@wireio/ql-tool-cli/cli/index.js"

/** Parse output flags through the REAL yargs (conflicts + checks); a failure rejects. */
async function parse(args: string[]): Promise<OutputOptions> {
  return applyOutputArgs(Yargs(args))
    .exitProcess(false)
    .fail((message, error) => {
      throw error ?? new QLUsageError(message)
    })
    .parseAsync() as Promise<OutputOptions>
}

describe("applyOutputArgs (real yargs)", () => {
  it("parses no flags and --all alone", async () => {
    await expect(parse([])).resolves.toBeDefined()
    await expect(parse(["--all"])).resolves.toMatchObject({ all: true })
  })

  it("parses paging and explicit windows", async () => {
    await expect(parse(["--page", "3", "--page-size", "50"])).resolves.toMatchObject({ page: 3, pageSize: 50 })
    await expect(parse(["--offset", "7", "--limit", "3"])).resolves.toMatchObject({ offset: 7, limit: 3 })
  })

  it.each([
    [["--all", "--page", "2"]],
    [["--all", "--limit", "5"]],
    [["--limit", "5", "--page", "2"]],
    [["--offset", "1", "--page-size", "2"]]
  ])("rejects the conflicting flags %j", async args => {
    await expect(parse(args)).rejects.toThrow(/mutually exclusive/)
  })

  it("rejects client view flags with --format raw but accepts paging", async () => {
    await expect(parse(["--format", "raw", "--sort", "x"])).rejects.toThrow(/--sort/)
    await expect(parse(["--format", "raw", "--page", "2"])).resolves.toMatchObject({ format: OutputFormat.raw, page: 2 })
  })

  it("parses --output-file and its -o alias into outputFile", async () => {
    await expect(parse(["--output-file", "x.csv"])).resolves.toMatchObject({ outputFile: "x.csv" })
    await expect(parse(["-o", "y.json"])).resolves.toMatchObject({ outputFile: "y.json" })
  })

  it("declares no yargs default for any option", () => {
    expect(declaredDefaults(applyOutputArgs(Yargs([])))).toEqual([])
  })
})

describe("resolveOutputArgs", () => {
  it("fills every default: page 1 of 100, table, header on", () => {
    const config = resolveOutputArgs({})
    expect(config).toMatchObject({
      format: OutputFormat.table,
      columns: [],
      sort: [],
      filter: [],
      header: true,
      showStats: false,
      showState: false,
      cellWidth: CellWidthMode.truncated,
      windowSource: OutputWindowSource.pager
    })
    expect(config.window).toEqual({ limit: QueryPager.DefaultPageSize, offset: 0 })
    expect(config.color).toBe(createOutputDefaultOptions().color)
  })

  it("--page 3 --page-size 50 → offset 100, limit 50; --all → no limit", () => {
    expect(resolveOutputArgs({ page: 3, pageSize: 50 }).window).toEqual({ limit: 50, offset: 100 })
    const all = resolveOutputArgs({ all: true })
    expect(all.pager.mode).toBe(PageSizeMode.all)
    expect(all.window).toEqual({ limit: null, offset: 0 })
  })

  it("--offset 7 --limit 3 → that exact window", () => {
    const config = resolveOutputArgs({ offset: 7, limit: 3 })
    expect(config.window).toEqual({ limit: 3, offset: 7 })
    expect(config.windowSource).toBe(OutputWindowSource.explicit)
    expect(resolveOutputArgs({ offset: 4 }).window).toEqual({ limit: undefined, offset: 4 })
  })

  it("infers the format from --output-file and lets --format win", () => {
    expect(resolveOutputArgs({ outputFile: "x.csv" }).format).toBe(OutputFormat.csv)
    expect(resolveOutputArgs({ outputFile: "x.csv", format: OutputFormat.json }).format).toBe(OutputFormat.json)
  })

  it("rejects an unknown extension, a bad page and a negative window", () => {
    expect(() => resolveOutputArgs({ outputFile: "x.unknown" })).toThrow(QLUsageError)
    expect(() => resolveOutputArgs({ page: 0 })).toThrow(QLUsageError)
    expect(() => resolveOutputArgs({ limit: -1 })).toThrow(/non-negative/)
    expect(() => resolveOutputArgs({ offset: 1.5 })).toThrow(/non-negative/)
  })
})

describe("OutputArgs helpers", () => {
  it("parses sorts and filters", () => {
    expect(OutputArgs.parseSort("name")).toEqual({ column: "name", direction: SortDirection.asc })
    expect(OutputArgs.parseSort("name:DESC")).toEqual({ column: "name", direction: SortDirection.desc })
    expect(OutputArgs.parseSort("a:b")).toEqual({ column: "a:b", direction: SortDirection.asc })
    expect(OutputArgs.parseFilter("name=bo=b")).toEqual({ column: "name", text: "bo=b" })
    expect(() => OutputArgs.parseFilter("name")).toThrow(QLUsageError)
  })

  it("builds view and render options; color off when writing a file", () => {
    const config = resolveOutputArgs({ sort: ["id:desc"], filter: ["name=b"], columns: ["id"], color: true, header: false })
    expect(OutputArgs.viewOptions(config)).toEqual({
      sorts: [{ column: "id", direction: SortDirection.desc }],
      filters: [{ column: "name", text: "b" }],
      columns: ["id"]
    })
    expect(OutputArgs.viewOptions(resolveOutputArgs({}))).toEqual({ sorts: [], filters: [] })
    expect(OutputArgs.renderOptions(config)).toMatchObject({ header: false, color: true })
    expect(OutputArgs.renderOptions(resolveOutputArgs({ color: true, outputFile: "x.txt" })).color).toBe(false)
  })

  it("assertRawFormatUnviewed passes non-raw formats", () => {
    expect(OutputArgs.assertRawFormatUnviewed({ format: OutputFormat.table, sort: ["x"] })).toBe(true)
  })
})
