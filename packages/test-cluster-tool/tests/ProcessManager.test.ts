import { ProcessManager } from "@wireio/test-cluster-tool"
import * as OS from "node:os"

describe("ProcessManager", () => {
  let pm: ProcessManager

  beforeEach(() => {
    pm = ProcessManager.setClusterPath(OS.tmpdir()).get()
  })

  afterEach(async () => {
    await pm.killAll()
    await pm.disconnect()
  })

  it("spawns and tracks a process", async () => {
    const handle = await pm.spawn({
      label: "echo-test",
      command: "sleep",
      args: ["60"]
    })
    expect(handle.pid).toBeGreaterThan(0)
    expect(handle.id).toBeGreaterThanOrEqual(0)
    expect(pm.count).toBe(1)
    expect(pm.get("echo-test")).toBeDefined()
  })

  it("rejects duplicate labels", async () => {
    await pm.spawn({ label: "dup", command: "sleep", args: ["60"] })
    await expect(
      pm.spawn({ label: "dup", command: "sleep", args: ["60"] })
    ).rejects.toThrow('Process "dup" is already running')
  })

  it("kills a process by label", async () => {
    await pm.spawn({ label: "killme", command: "sleep", args: ["60"] })
    expect(pm.count).toBe(1)
    const handle = pm.get("killme")!
    await handle.kill()
    expect(pm.count).toBe(0)
  })

  it("killAll stops all processes", async () => {
    await pm.spawn({ label: "a", command: "sleep", args: ["60"] })
    await pm.spawn({ label: "b", command: "sleep", args: ["60"] })
    expect(pm.count).toBe(2)
    await pm.killAll()
    expect(pm.count).toBe(0)
  })

  it("getAll returns empty array when nothing is tracked", () => {
    expect(pm.getAll()).toEqual([])
  })

  it("getAll returns each {label, handle} pair in insertion order", async () => {
    await pm.spawn({ label: "first", command: "sleep", args: ["60"] })
    await pm.spawn({ label: "second", command: "sleep", args: ["60"] })

    const entries = pm.getAll()
    expect(entries.map(e => e.label)).toEqual(["first", "second"])
    expect(entries[0].handle.pid).toBeGreaterThan(0)
    expect(entries[1].handle.pid).toBeGreaterThan(0)
    // Returned array is a copy — mutating it doesn't leak back into the
    // manager.
    entries.pop()
    expect(pm.count).toBe(2)
  })
})
