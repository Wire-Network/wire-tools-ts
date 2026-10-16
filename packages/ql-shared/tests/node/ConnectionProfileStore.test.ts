import Fs from "node:fs"
import Path from "node:path"

import { ConnectionProfileStore } from "@wireio/ql-shared/node"

import { useTemporaryDirectory } from "../common/temporaryDirectory.js"

describe("ConnectionProfileStore", () => {
  const directory = useTemporaryDirectory("ql-profiles-")
  let store: ConnectionProfileStore
  beforeEach(() => {
    store = new ConnectionProfileStore(Path.join(directory(), "profiles.json"))
  })

  it("starts empty", () => {
    expect(store.list()).toEqual([])
    expect(store.defaultProfile()).toBeUndefined()
    expect(store.get("x")).toBeUndefined()
  })

  it("upserts, defaults, replaces by name and persists only custom owners", () => {
    store.upsert({ name: "local", endpoint: "http://local.invalid" })
    store.upsert({ name: "remote", endpoint: "https://api.example", owners: ["sysio.opreg"] })
    store.upsert({ name: "local", endpoint: "http://local-moved.invalid" })
    store.setDefault("remote")
    expect(store.list().map(profile => profile.endpoint)).toEqual(["http://local-moved.invalid", "https://api.example"])
    expect(store.defaultProfile().name).toBe("remote")
    const persisted = JSON.parse(Fs.readFileSync(store.file, "utf8"))
    expect(persisted.profiles[0].owners).toBeUndefined()
    expect(persisted.profiles[1].owners).toEqual(["sysio.opreg"])
  })

  it("removing the default clears it; clearing with null persists null", () => {
    store.upsert({ name: "a", endpoint: "http://a" })
    store.setDefault("a")
    store.remove("a")
    expect(store.read()).toEqual({ defaultProfile: null, profiles: [] })
    store.upsert({ name: "b", endpoint: "http://b" })
    store.setDefault("b")
    store.setDefault(null)
    expect(JSON.parse(Fs.readFileSync(store.file, "utf8")).defaultProfile).toBeNull()
  })

  it("asserts unknown profiles and invalid input", () => {
    expect(() => store.assertProfile("missing")).toThrow("no connection profile named missing")
    expect(() => store.remove("missing")).toThrow()
    expect(() => store.setDefault("missing")).toThrow()
    expect(() => store.upsert({ name: "bad", endpoint: "ftp://x" })).toThrow()
  })

  it("watches for changes", async () => {
    const received: string[] = [],
      unwatch = store.watch(document => received.push(...document.profiles.map(profile => profile.name)))
    new ConnectionProfileStore(store.file).upsert({ name: "other", endpoint: "http://o" })
    await new Promise(resolve => setTimeout(resolve, 250))
    unwatch()
    expect(received).toContain("other")
  })
})
