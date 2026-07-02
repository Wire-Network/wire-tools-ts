import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import { Readable } from "node:stream"
import {
  ManagedProcess,
  ProcessManager
} from "@wireio/test-cluster-tool/cluster/processes"

/** A concrete ManagedProcess for tests — trivial exe, fast verify window. */
class FakeProcess extends ManagedProcess {
  constructor(
    manager: ProcessManager,
    label: string,
    private readonly exePath = "/bin/true",
    private readonly argv: string[] = [],
    private readonly ready = true
  ) {
    super(manager, { label, kind: ManagedProcess.Kind.anvil })
  }
  get exe(): string {
    return this.exePath
  }
  get args(): string[] {
    return this.argv
  }
  protected verifyReady(): Promise<boolean> {
    return Promise.resolve(this.ready)
  }
  protected get verifyTimeoutMs(): number {
    return 50
  }
  protected get verifyIntervalMs(): number {
    return 10
  }
  /** Public wrapper so the test can drive the protected captureOutput. */
  capture(stream: NodeJS.ReadableStream): void {
    this.captureOutput(stream)
  }
}

describe("ProcessManager + ManagedProcess", () => {
  let dir: string
  let manager: ProcessManager
  /** A copy of `sleep` named `anvil` — a live pid with a MANAGED basename. */
  let orphanPid: number
  let orphanPidFile: string
  /** A pidfile pointing at THIS jest process — an UNMANAGED basename (node). */
  let unmanagedPidFile: string

  /** Whether `pid` is still alive (signal 0 probe). */
  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * The pid's live command basename — "" once exited. A killed child of THIS
   * jest process lingers as a zombie (kill(pid, 0) still succeeds) but its
   * `/proc/<pid>/cmdline` empties, which is exactly the sweep's own liveness
   * semantics.
   */
  function commandBasename(pid: number): string {
    try {
      const cmdline = Fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
      return Path.basename(cmdline.split("\0")[0] ?? "")
    } catch {
      return ""
    }
  }

  beforeAll(async () => {
    dir = Fs.mkdtempSync(Path.join(Os.tmpdir(), "procmgr-"))
    // Seed orphan pidfiles BEFORE the first push — the lazy one-time sweep
    // must kill managed-basename pids from THIS cluster's pidfiles and prune
    // stale/unmanaged ones, and must NEVER touch anything else on the host.
    const fakeAnvil = Path.join(dir, "anvil")
    Fs.copyFileSync("/usr/bin/sleep", fakeAnvil)
    const { spawn } = await import("node:child_process")
    const child = spawn(fakeAnvil, ["300"], { stdio: "ignore", detached: true })
    child.unref()
    orphanPid = child.pid
    const anvilDirectory = Path.join(dir, "data", "anvil")
    Fs.mkdirSync(anvilDirectory, { recursive: true })
    orphanPidFile = Path.join(anvilDirectory, "anvil.pid")
    Fs.writeFileSync(orphanPidFile, String(orphanPid))
    const nodeDirectory = Path.join(dir, "data", "node_99")
    Fs.mkdirSync(nodeDirectory, { recursive: true })
    unmanagedPidFile = Path.join(nodeDirectory, "node_99.pid")
    Fs.writeFileSync(unmanagedPidFile, String(process.pid))

    ProcessManager.setClusterPath(dir)
    manager = ProcessManager.get()
  })
  afterEach(async () => {
    await manager.stopAll()
  })
  afterAll(() => {
    if (isAlive(orphanPid)) process.kill(orphanPid, "SIGKILL")
    Fs.rmSync(dir, { recursive: true, force: true })
  })

  it("self-registers in the constructor (inverted ownership)", () => {
    const managed = new FakeProcess(manager, "self-reg")
    expect(manager.get("self-reg")).toBe(managed)
  })

  it("the first push swept the cluster's own managed orphan pid", () => {
    // Armed by the FakeProcess above: SIGINT → 2s grace → SIGKILL stragglers.
    // The child zombifies under jest (unreaped), so assert the sweep's own
    // liveness semantics: it no longer runs the managed binary.
    expect(commandBasename(orphanPid)).toBe("")
  })

  it("pruned the unmanaged-basename pidfile WITHOUT killing its pid", () => {
    expect(Fs.existsSync(unmanagedPidFile)).toBe(false)
    expect(isAlive(process.pid)).toBe(true) // this jest worker survived
  })

  it("throws on a duplicate label", () => {
    new FakeProcess(manager, "dup")
    expect(() => new FakeProcess(manager, "dup")).toThrow(/already registered/)
  })

  describe("remove (the restart primitive)", () => {
    it("throws for an unregistered label", () => {
      expect(() => manager.remove("never-registered")).toThrow(/not registered/)
    })

    it("refuses while the child is running", async () => {
      const managed = new FakeProcess(manager, "rm-running", "/usr/bin/sleep", ["300"])
      await managed.start()
      expect(managed.isRunning).toBe(true)
      expect(() => manager.remove("rm-running")).toThrow(/still running/)
      await managed.kill()
    })

    it("deregisters an exited process so the label is reusable", async () => {
      const managed = new FakeProcess(manager, "rm-exited", "/bin/true")
      await managed.start()
      await managed.wait()
      expect(managed.isRunning).toBe(false)
      manager.remove("rm-exited")
      expect(manager.get("rm-exited")).toBeNull()
      const second = new FakeProcess(manager, "rm-exited")
      expect(manager.get("rm-exited")).toBe(second)
    })

    it("isRunning is false before start", () => {
      const managed = new FakeProcess(manager, "never-started")
      expect(managed.isRunning).toBe(false)
    })
  })

  it("defaults cwd to the exe's directory and env to empty", () => {
    const process = new FakeProcess(manager, "defaults", "/usr/local/bin/foo")
    expect(process.cwd).toBe("/usr/local/bin")
    expect(process.env).toEqual({})
  })

  it("get returns null for an unknown label", () => {
    expect(manager.get("missing")).toBeNull()
  })

  it("captureOutput writes each non-empty line to the raw aggregate", async () => {
    const process = new FakeProcess(manager, "cap")
    const writeSpy = jest.spyOn(manager, "writeRaw")
    const stream = Readable.from(["line1\nline2\n"])
    process.capture(stream)
    await new Promise<void>(resolve => stream.once("end", () => resolve()))
    expect(writeSpy).toHaveBeenCalledWith("cap", "line1")
    expect(writeSpy).toHaveBeenCalledWith("cap", "line2")
    writeSpy.mockRestore()
  })

  describe("stopAll", () => {
    it("gracefully stops each registered process", async () => {
      const process = new FakeProcess(manager, "stop-me")
      const stopSpy = jest.spyOn(process, "stop")
      await manager.stopAll()
      expect(stopSpy).toHaveBeenCalled()
    })
    it("force-kills each registered process when forceKill", async () => {
      const process = new FakeProcess(manager, "kill-me")
      const killSpy = jest.spyOn(process, "kill")
      await manager.stopAll(true)
      expect(killSpy).toHaveBeenCalled()
    })
  })

  describe("start", () => {
    it("spawns and resolves once verifyReady passes", async () => {
      const process = new FakeProcess(manager, "sleeper", "/bin/sleep", ["5"])
      await expect(process.start()).resolves.toBe(process)
      expect(process.pid).toBeGreaterThan(0)
      await process.kill()
    })

    it("rejects when verifyReady never passes within the timeout", async () => {
      const process = new FakeProcess(manager, "never", "/bin/sleep", ["5"], false)
      await expect(process.start()).rejects.toThrow(/did not pass verifyReady/)
      await process.kill()
    })
  })
})
