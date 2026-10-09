import Path from "node:path"

import { SavedQueryStore } from "@wireio/ql-shared/node"

import { useTemporaryDirectory } from "../common/temporaryDirectory.js"

describe("SavedQueryStore", () => {
  const directory = useTemporaryDirectory("ql-saved-")
  let store: SavedQueryStore
  beforeEach(() => {
    store = new SavedQueryStore(Path.join(directory(), "saved-queries.json"))
  })

  it("saves, updates by name, gets by id and by name and removes", () => {
    const first = store.save("ops", "SELECT 1"),
      updated = store.save("ops", "SELECT 2")
    expect(updated.id).toBe(first.id)
    expect(updated.createdAt).toBe(first.createdAt)
    expect(store.list()).toHaveLength(1)
    expect(store.getByName("ops").query).toBe("SELECT 2")
    expect(store.getById(first.id).name).toBe("ops")
    expect(store.getById("ops")).toBeUndefined()
    expect(store.getByName(first.id)).toBeUndefined()
    store.save("other", "SELECT 3")
    store.remove(first.id)
    expect(store.list().map(saved => saved.name)).toEqual(["other"])
  })

  it("save updates the entry present in the document being written (another writer's entry included)", () => {
    new SavedQueryStore(store.file).save("shared", "SELECT 1")
    const updated = store.save("shared", "SELECT 2")
    expect(store.list()).toEqual([updated])
  })

  it("assertSavedQuery resolves an id before a name", () => {
    const target = store.save("target", "SELECT 1"),
      shadow = store.save(target.id, "SELECT 2")
    expect(store.assertSavedQuery(target.id)).toEqual(target)
    expect(store.assertSavedQuery(shadow.id)).toEqual(shadow)
    expect(store.assertSavedQuery("target")).toEqual(target)
  })

  it("asserts unknown entries", () => {
    expect(store.getByName("nope")).toBeUndefined()
    expect(() => store.assertSavedQuery("nope")).toThrow("no saved query nope")
    expect(() => store.remove("nope")).toThrow()
  })

  it("watches for changes", async () => {
    const received: number[] = [],
      unwatch = store.watch(document => received.push(document.queries.length))
    new SavedQueryStore(store.file).save("x", "SELECT 1")
    await new Promise(resolve => setTimeout(resolve, 250))
    unwatch()
    expect(received).toContain(1)
  })
})
