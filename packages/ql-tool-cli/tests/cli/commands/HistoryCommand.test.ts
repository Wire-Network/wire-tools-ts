import { QueryOutcome, type QueryHistoryEntry } from "@wireio/ql-shared"

import { HistoryCommand, QLExitCode, QLUsageError } from "@wireio/ql-tool-cli/cli/index.js"
import { ListingColumnSeparator, ListingEmptyCell } from "@wireio/ql-tool-cli/utils/index.js"

import { runWql } from "../../common/runWql.js"
import { useStubEngine } from "../../common/stubEngine.js"
import { createTestContext } from "../../common/testContext.js"

describe("wql history", () => {
  const engine = useStubEngine()

  it("lists (newest first, --search, --count), reruns by id and clears", async () => {
    const { context } = createTestContext()
    await runWql(["-u", engine().endpoint, "SELECT 1 FROM a.b"], context)
    await runWql(["-u", engine().endpoint, "SELECT 2 FROM a.b"], context)
    const listed = await runWql(["history", "list"], context)
    expect(listed.stdout).toHaveLength(2)
    expect(listed.stdout[0]).toContain("SELECT 2 FROM a.b")
    expect((await runWql(["history", "list", "--search", "select 1"], context)).stdout).toHaveLength(1)
    expect((await runWql(["history", "list", "--count", "1"], context)).stdout).toHaveLength(1)
    const [oldest] = context.historyStore.list().slice(-1),
      rerun = await runWql(["history", "rerun", oldest.id, "-f", "csv"], context)
    expect(rerun.exitCode).toBe(QLExitCode.success)
    expect(engine().requests.at(-1).params.query).toBe("SELECT 1 FROM a.b")
    await runWql(["history", "clear"], context)
    expect(context.historyStore.list()).toEqual([])
  })

  it("rerun of an unknown id is a usage error", async () => {
    expect((await runWql(["history", "rerun", "nope"], createTestContext().context)).exitCode).toBe(QLExitCode.usage)
  })

  it("connectionFor: given flags win, else a saved profile name, else an ad-hoc endpoint", () => {
    const { context } = createTestContext()
    context.profileStore.upsert({ name: "saved", endpoint: "http://s.example" })
    const entry = { id: "i", profile: "saved", query: "q", executedAt: new Date().toISOString(), outcome: QueryOutcome.success, errorKind: null, returnedRows: 1, wallTimeMs: 1 }
    expect(HistoryCommand.connectionFor(context, entry, { url: "http://x.example" })).toEqual({ url: "http://x.example" })
    expect(HistoryCommand.connectionFor(context, entry, {})).toEqual({ profile: "saved" })
    expect(HistoryCommand.connectionFor(context, { ...entry, profile: "http://adhoc.example" }, {})).toEqual({ url: "http://adhoc.example" })
    expect(HistoryCommand.connectionFor(context, { ...entry, profile: "gone" }, {})).toEqual({})
    expect(HistoryCommand.entryLine({ ...entry, query: "a\nb" })).toContain("\tsuccess\t1\ti\tsaved\ta b")
  })

  it("assertEntry finds a record by id; entryLine puts the query on one line", () => {
    const { context } = createTestContext(),
      entry = { id: "i", profile: "p", query: "SELECT\n  1", executedAt: "2026-10-07T00:00:00.000Z", outcome: QueryOutcome.success, errorKind: null, returnedRows: 1, wallTimeMs: 1 }
    context.historyStore.append(entry)
    expect(HistoryCommand.assertEntry(context, "i")).toEqual(entry)
    expect(() => HistoryCommand.assertEntry(context, "missing")).toThrow(QLUsageError)
    expect(HistoryCommand.entryLine(entry)).toBe("2026-10-07T00:00:00.000Z\tsuccess\t1\ti\tp\tSELECT 1")
    expect(HistoryCommand.entryLine({ ...entry, returnedRows: null })).toContain("\t-\t")
  })
})

/** A failed run's record (no returned rows). */
const historyEntryWithoutRows: QueryHistoryEntry = {
  id: "i",
  executedAt: "2026-09-21T12:00:00.000Z",
  outcome: QueryOutcome.transportError,
  errorKind: null,
  returnedRows: null,
  wallTimeMs: 1,
  profile: "p",
  query: "SELECT 1"
}

describe("HistoryCommand.ClearedText", () => {
  it("is the clear confirmation shared with the TUI", () => {
    expect(HistoryCommand.ClearedText).toBe("history cleared")
  })

  it("entryLine shows ListingEmptyCell for a run without rows", () => {
    const line = HistoryCommand.entryLine(historyEntryWithoutRows)
    expect(line.split(ListingColumnSeparator)[2]).toBe(ListingEmptyCell)
  })
})
