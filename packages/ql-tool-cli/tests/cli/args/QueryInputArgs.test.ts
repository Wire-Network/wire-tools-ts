import Fs from "node:fs"
import Path from "node:path"
import { PassThrough } from "node:stream"

import Yargs from "yargs"

import { applyQueryInputArgs, QLUsageError, QueryInputArgs, type QueryInputOptions, type QueryTextSource } from "@wireio/ql-tool-cli/cli/index.js"
import { createTemporaryDirectory } from "../../common/temporaryDirectory.js"

/** A stdin source. */
function source(text: string = null): QueryTextSource {
  const stdin = new PassThrough()
  if (text != null) stdin.end(text)
  return { stdin, stdinIsTTY: text == null }
}

describe("QueryInputArgs.readQueryText", () => {
  it("reads the positional", async () => {
    await expect(QueryInputArgs.readQueryText({ query: " SELECT 1 " }, source())).resolves.toBe("SELECT 1")
  })

  it("reads --query-file", async () => {
    const file = Path.join(createTemporaryDirectory("wql-q-"), "q.sql")
    Fs.writeFileSync(file, "SELECT * FROM a.b\n")
    await expect(QueryInputArgs.readQueryText({ queryFile: file }, source())).resolves.toBe("SELECT * FROM a.b")
  })

  it("reads piped stdin when no other source is given, and `-` explicitly", async () => {
    await expect(QueryInputArgs.readQueryText({}, source("SELECT 2"))).resolves.toBe("SELECT 2")
    await expect(QueryInputArgs.readQueryText({ query: "-" }, source("SELECT 3"))).resolves.toBe("SELECT 3")
  })

  it("rejects no source (TTY stdin), several sources, an empty query and a missing file", async () => {
    await expect(QueryInputArgs.readQueryText({}, source())).rejects.toBeInstanceOf(QLUsageError)
    await expect(QueryInputArgs.readQueryText({ query: "SELECT 1", queryFile: "x.sql" }, source())).rejects.toThrow(/not several/)
    await expect(QueryInputArgs.readQueryText({ query: "   " }, source())).rejects.toThrow(/empty/)
    await expect(QueryInputArgs.readQueryText({ queryFile: "/nonexistent/q.sql" }, source())).rejects.toThrow(/not found/)
  })
})

describe("applyQueryInputArgs", () => {
  it("registers the positional and --query-file / -F", async () => {
    const parsed: QueryInputOptions[] = []
    await Yargs(["SELECT 1", "-F", "q.sql"])
      .command("$0 [query]", "", builder => applyQueryInputArgs(builder), argv => void parsed.push(argv))
      .parseAsync()
    expect(parsed).toEqual([expect.objectContaining({ query: "SELECT 1", queryFile: "q.sql" })])
  })
})

describe("QueryInputArgs.EmptyQueryText", () => {
  it("is the refusal of a whitespace-only query", async () => {
    await expect(QueryInputArgs.readQueryText({ query: "   " }, { stdin: null, stdinIsTTY: true })).rejects.toThrow(QueryInputArgs.EmptyQueryText)
  })
})
