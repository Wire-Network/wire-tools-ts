import Path from "node:path"

import { QueryOutcome, type QueryHistoryEntry } from "@wireio/ql-shared"
import { QueryHistoryStore } from "@wireio/ql-shared/node"
import { Level } from "@wireio/shared"

import { recordHistory } from "@wireio/ql-tool-cli/utils/index.js"

import { captureLogs } from "../common/logCapture.js"
import { useTemporaryDirectory } from "../common/temporaryDirectory.js"

/** A history record. */
const entry: QueryHistoryEntry = {
  id: "r-1",
  profile: "local",
  query: "SELECT 1",
  executedAt: "2026-10-07T00:00:00.000Z",
  outcome: QueryOutcome.success,
  errorKind: null,
  returnedRows: 1,
  wallTimeMs: 1
}

describe("recordHistory", () => {
  const directory = useTemporaryDirectory("wql-history-utils-")

  it("appends the record", () => {
    const store = new QueryHistoryStore({ file: Path.join(directory(), "history.jsonl") })
    expect(recordHistory(store, entry)).toBe(true)
    expect(store.get("r-1")).toEqual(entry)
  })

  it("logs a failed append and never throws", () => {
    const store = new QueryHistoryStore({ file: Path.join(directory(), "history.jsonl") }),
      logs = captureLogs()
    jest.spyOn(store, "append").mockImplementation(() => {
      throw new Error("read-only state directory")
    })
    try {
      expect(recordHistory(store, entry)).toBe(false)
      expect(logs.records.filter(record => record.level === Level.warn).map(record => record.message)).toEqual([
        "history append failed: read-only state directory"
      ])
    } finally {
      logs.restore()
    }
  })
})
