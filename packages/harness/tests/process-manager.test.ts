import { ProcessManager } from "../src/processes/process-manager"

describe("ProcessManager", () => {
  let pm: ProcessManager

  beforeEach(() => {
    pm = new ProcessManager()
  })

  afterEach(async () => {
    await pm.killAll()
  })

  it("spawns and tracks a process", async () => {
    const handle = await pm.spawn({
      label: "echo-test",
      command: "sleep",
      args: ["60"],
    })
    expect(handle.pid).toBeGreaterThan(0)
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
    // Give a moment for cleanup
    await new Promise(r => setTimeout(r, 200))
    expect(pm.count).toBe(0)
  })

  it("killAll stops all processes", async () => {
    await pm.spawn({ label: "a", command: "sleep", args: ["60"] })
    await pm.spawn({ label: "b", command: "sleep", args: ["60"] })
    expect(pm.count).toBe(2)
    await pm.killAll()
    await new Promise(r => setTimeout(r, 200))
    expect(pm.count).toBe(0)
  })
})
