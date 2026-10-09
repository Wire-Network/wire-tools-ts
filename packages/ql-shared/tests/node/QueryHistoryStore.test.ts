import { execFileSync, spawn } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"

import { QueryErrorKind, QueryOutcome, type QueryHistoryEntry } from "@wireio/ql-shared"
import { createQueryHistoryStoreDefaultOptions, QLPaths, QueryHistoryStore } from "@wireio/ql-shared/node"

import { useTemporaryDirectory } from "../common/temporaryDirectory.js"

const PackagePath = Path.join(__dirname, "..", "..")

const entry = (index: number, query = `SELECT ${index}`): QueryHistoryEntry => ({
  id: `r-${index}`,
  profile: "local",
  query,
  executedAt: new Date(Date.UTC(2026, 9, 7, 0, 0, index)).toISOString(),
  outcome: QueryOutcome.success,
  errorKind: null,
  returnedRows: index,
  wallTimeMs: 1
})

describe("QueryHistoryStore", () => {
  const directory = useTemporaryDirectory("ql-history-")
  let store: QueryHistoryStore
  beforeEach(() => {
    store = new QueryHistoryStore({ file: Path.join(directory(), "state", "history.jsonl") })
  })

  it("defaults to the shared history file and chunk size; an explicit undefined keeps a default", () => {
    expect(createQueryHistoryStoreDefaultOptions()).toEqual({ file: QLPaths.historyFile(), tailChunkBytes: QueryHistoryStore.TailChunkBytes })
    expect(new QueryHistoryStore({ file: undefined }).file).toBe(QLPaths.historyFile())
    expect(store.config.tailChunkBytes).toBe(QueryHistoryStore.TailChunkBytes)
  })

  it("writes each record as one compact line", () => {
    store.append(entry(1))
    const [line] = Fs.readFileSync(store.file, "utf8").split(QueryHistoryStore.LineSeparator)
    expect(line).toBe(JSON.stringify(entry(1)))
  })

  it("decodes a multi-byte query straddling a chunk boundary", () => {
    const small = new QueryHistoryStore({ file: store.file, tailChunkBytes: 7 }),
      queries = ["SELECT '中文字符' FROM a.b", "SELECT '😀 émoji ✓' FROM c.d", "SELECT 3"]
    queries.forEach((query, index) => small.append(entry(index, query)))
    expect(small.list().map(found => found.query)).toEqual([...queries].reverse())
  })

  it("splitLines splits at the newline byte only", () => {
    const pieces = QueryHistoryStore.splitLines(Buffer.from("a中\nb\n\nc", "utf8")).map(piece => piece.toString("utf8"))
    expect(pieces).toEqual(["a中", "b", "", "c"])
    expect(QueryHistoryStore.splitLines(Buffer.alloc(0)).map(piece => piece.length)).toEqual([0])
  })

  it("is empty when the file is missing", () => {
    expect(store.list()).toEqual([])
    expect(() => store.clear()).not.toThrow()
  })

  it("appends one line per entry and lists newest first", () => {
    store.append(entry(1))
    store.append({ ...entry(2), outcome: QueryOutcome.engineError, errorKind: QueryErrorKind.QUERY_SYNTAX, returnedRows: null })
    expect(Fs.readFileSync(store.file, "utf8").trim().split("\n")).toHaveLength(2)
    expect(store.list().map(found => found.id)).toEqual(["r-2", "r-1"])
  })

  it("limits and searches across chunk boundaries", () => {
    const longQuery = `SELECT ${"x".repeat(QueryHistoryStore.TailChunkBytes / 4)} FROM a.b`
    Array.from({ length: 12 }, (_value, index) => entry(index, index % 3 === 0 ? `${longQuery} -- needle ${index}` : `SELECT ${index}`)).forEach(
      record => store.append(record)
    )
    expect(store.list({ limit: 3 }).map(found => found.id)).toEqual(["r-11", "r-10", "r-9"])
    expect(store.list({ search: "NEEDLE" }).map(found => found.id)).toEqual(["r-9", "r-6", "r-3", "r-0"])
    expect(store.list({ limit: 100 })).toHaveLength(12)
  })

  it("skips malformed lines", () => {
    store.append(entry(1))
    Fs.appendFileSync(store.file, "{not json}\n")
    store.append(entry(2))
    expect(store.list().map(found => found.id)).toEqual(["r-2", "r-1"])
  })

  it("gets a record by id (the newest when ids repeat), undefined when absent", () => {
    expect(store.get("r-1")).toBeUndefined()
    store.append(entry(1))
    store.append(entry(2))
    store.append({ ...entry(1), query: "SELECT again" })
    expect(store.get("r-2")).toEqual(entry(2))
    expect(store.get("r-1").query).toBe("SELECT again")
    expect(store.get("r-9")).toBeUndefined()
  })

  it("clear truncates", () => {
    store.append(entry(1))
    store.clear()
    expect(store.list()).toEqual([])
  })

  it("keeps every record from two concurrent appending processes", async () => {
    execFileSync(Path.join(PackagePath, "node_modules", ".bin", "tsc"), ["-b", "tsconfig.cjs.json"], { cwd: PackagePath })
    const module = Path.join(PackagePath, "lib", "cjs", "node", "index.js"),
      perProcess = 200,
      script = (prefix: string) =>
        `const { QueryHistoryStore } = require(${JSON.stringify(module)});` +
        `const store = new QueryHistoryStore({ file: ${JSON.stringify(store.file)} });` +
        `for (let i = 0; i < ${perProcess}; i++) store.append({ id: "${prefix}-" + i, profile: "p", query: "SELECT " + i, executedAt: new Date().toISOString(), outcome: "success", errorKind: null, returnedRows: 1, wallTimeMs: 1 });`,
      run = (prefix: string) =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(process.execPath, ["-e", script(prefix)], { stdio: "inherit" })
          child.once("error", reject)
          child.once("exit", code => resolve(code))
        })
    expect(await Promise.all([run("a"), run("b")])).toEqual([0, 0])
    const ids = store.list({ limit: perProcess * 4 }).map(found => found.id)
    expect(ids).toHaveLength(perProcess * 2)
    expect(new Set(ids).size).toBe(perProcess * 2)
  })
})
