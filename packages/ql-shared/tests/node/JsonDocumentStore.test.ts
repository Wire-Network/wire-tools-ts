import Fs from "node:fs"
import Path from "node:path"

import { Level } from "@wireio/shared"

import { SavedQueriesDocument, SavedQueriesDocumentCodec } from "@wireio/ql-shared"
import { createJsonDocumentStoreDefaultOptions, JsonDocumentStore } from "@wireio/ql-shared/node"

import { LogCapture } from "../common/logCapture.js"
import { useTemporaryDirectory } from "../common/temporaryDirectory.js"

const now = "2026-10-07T12:00:00.000Z"

describe("JsonDocumentStore", () => {
  const directory = useTemporaryDirectory("ql-store-")
  let store: JsonDocumentStore<SavedQueriesDocument>
  beforeEach(() => {
    store = new JsonDocumentStore({
      file: Path.join(directory(), "nested", "doc.json"),
      codec: SavedQueriesDocumentCodec,
      createEmpty: SavedQueriesDocument.empty,
      watchDebounceMs: 10
    })
  })

  const document = (name: string): SavedQueriesDocument => ({ queries: [{ id: name, name, query: "q", createdAt: now, updatedAt: now }] })

  it("reads the empty document for a missing file and round-trips writes", () => {
    expect(store.read()).toEqual({ queries: [] })
    store.write(document("a"))
    expect(store.read()).toEqual(document("a"))
    expect(store.update(current => ({ queries: [...current.queries, ...document("b").queries] })).queries).toHaveLength(2)
    expect(store.config.watchDebounceMs).toBe(10)
  })

  it("never leaves the original half-written (temp file + rename)", () => {
    store.write(document("a"))
    const leftover = Path.join(Path.dirname(store.config.file), `doc.json.crash${JsonDocumentStore.TemporarySuffix}`)
    Fs.writeFileSync(leftover, "{ truncated")
    expect(store.read()).toEqual(document("a"))
    expect(Fs.readdirSync(Path.dirname(store.config.file)).filter(name => name.endsWith(JsonDocumentStore.TemporarySuffix))).toEqual([
      "doc.json.crash.tmp"
    ])
  })

  it("defaults the debounce, and an explicit undefined keeps it", () => {
    expect(createJsonDocumentStoreDefaultOptions()).toEqual({ watchDebounceMs: JsonDocumentStore.DefaultWatchDebounceMs })
    const defaulted = new JsonDocumentStore({
      file: store.config.file,
      codec: SavedQueriesDocumentCodec,
      createEmpty: SavedQueriesDocument.empty,
      watchDebounceMs: undefined
    })
    expect(defaulted.config.watchDebounceMs).toBe(JsonDocumentStore.DefaultWatchDebounceMs)
  })

  it("logs a watcher error instead of crashing, and unwatch still works", () => {
    const logs = new LogCapture().install(),
      watchSpy = jest.spyOn(Fs, "watch")
    try {
      const unwatch = store.watch(() => undefined),
        watcher = watchSpy.mock.results[0].value as Fs.FSWatcher
      expect(() => watcher.emit(JsonDocumentStore.WatchErrorEvent, new Error("ENOSPC"))).not.toThrow()
      expect(logs.messages(Level.warn).some(message => message.includes("ENOSPC"))).toBe(true)
      unwatch()
    } finally {
      watchSpy.mockRestore()
      logs.uninstall()
    }
  })

  it("rejects an invalid document on read", () => {
    Fs.mkdirSync(Path.dirname(store.config.file), { recursive: true })
    Fs.writeFileSync(store.config.file, "{\"queries\": 5}")
    expect(() => store.read()).toThrow("validation failed")
  })

  it("readOrEmpty returns the document, or the empty document with a logged warning when it is invalid", () => {
    expect(store.readOrEmpty()).toEqual({ queries: [] })
    store.write(document("a"))
    expect(store.readOrEmpty()).toEqual(document("a"))
    const logs = new LogCapture().install()
    try {
      Fs.writeFileSync(store.config.file, "{\"queries\": 5}")
      expect(store.readOrEmpty()).toEqual({ queries: [] })
      expect(logs.messages(Level.warn).some(message => message.includes(`ignoring unreadable ${store.config.file}`))).toBe(true)
      expect(Fs.readFileSync(store.config.file, "utf8")).toBe("{\"queries\": 5}")
    } finally {
      logs.uninstall()
    }
  })

  it("notifies a watcher on another writer's change (debounced) and stops after unwatch", async () => {
    const received: SavedQueriesDocument[] = [],
      unwatch = store.watch(next => received.push(next)),
      other = new JsonDocumentStore({ file: store.config.file, codec: SavedQueriesDocumentCodec, createEmpty: SavedQueriesDocument.empty })
    other.write(document("x"))
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(received.at(-1)).toEqual(document("x"))
    unwatch()
    const count = received.length
    other.write(document("y"))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(received).toHaveLength(count)
  })
})
