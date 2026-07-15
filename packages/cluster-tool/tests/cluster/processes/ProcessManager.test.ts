import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import type { ChildProcess } from "node:child_process"
import { Readable } from "node:stream"
import { Deferred, guard } from "@wireio/shared"
import {
  ManagedProcess,
  ProcessManager,
  ProcessSignalName
} from "@wireio/cluster-tool/cluster/processes"

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
  let orphanChild: ChildProcess
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
    orphanChild = spawn(fakeAnvil, ["300"], { stdio: "ignore", detached: true })
    orphanChild.unref()
    orphanPid = orphanChild.pid
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
  afterAll(async () => {
    // The sweep normally killed the orphan mid-suite; make sure its handle is
    // FULLY closed (exit + stdio) before the worker tears down — a child
    // handle still closing at worker exit is the intermittent jest
    // "worker failed to exit gracefully" warning.
    const closed = Deferred.useCallback<void>(deferred => {
      if (orphanChild.exitCode != null || orphanChild.signalCode != null) {
        deferred.resolve()
        return
      }
      orphanChild.once("close", () => deferred.resolve())
    }).promise
    guard(() => process.kill(orphanPid, ProcessSignalName.SIGKILL))
    await closed
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

  it("start() lands the spawn command in the running step's extra", async () => {
    const { StepExtraRecorder } = await import("@wireio/cluster-tool/report")
    const recorder = new StepExtraRecorder()
    const managed = new FakeProcess(manager, "spawn-extra", "/bin/sleep", ["1"])
    await StepExtraRecorder.runWith(recorder, () => managed.start())
    await managed.stop()
    expect(recorder.calls[0]).toEqual({
      client: "process",
      kind: "spawn",
      label: "spawn-extra",
      command: ["/bin/sleep", "1"],
      cwd: managed.cwd
    })
  })

  it("throws on a duplicate label", () => {
    new FakeProcess(manager, "dup")
    expect(() => new FakeProcess(manager, "dup")).toThrow(/already registered/)
  })

  it("stop() clears the graceful-kill escalation timer once the child exits", async () => {
    // Regression: the 30s GracefulKillMs race timer used to survive a fast
    // graceful exit — one pending handle per stopped process, which held jest
    // workers open past their exit grace ("failed to exit gracefully").
    const managed = new FakeProcess(manager, "timer-hygiene", "/usr/bin/sleep", ["300"])
    await managed.start()
    const clearTimeoutSpy = jest.spyOn(global, "clearTimeout")
    const timeoutSpy = jest.spyOn(global, "setTimeout")
    try {
      await managed.stop()
      // The escalation timer stop() armed must be among the handles cleared.
      const escalation = timeoutSpy.mock.results.find(
        (result, index) =>
          timeoutSpy.mock.calls[index][1] === ManagedProcess.GracefulKillMs
      )
      expect(escalation).toBeDefined()
      expect(clearTimeoutSpy.mock.calls.map(call => call[0])).toContain(
        escalation.value
      )
    } finally {
      clearTimeoutSpy.mockRestore()
      timeoutSpy.mockRestore()
    }
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

    it("fails FAST with the exit code when the child dies before ready (crash ≠ slow boot)", async () => {
      // /bin/false exits immediately with code 1; verifyReady never passes.
      // The verify loop must surface the death + exit code well inside the
      // budget instead of burning it and reporting the generic timeout line
      // (a crashed daemon and a slow boot must be distinguishable from the
      // failure message alone).
      const process = new FakeProcess(manager, "dies", "/bin/false", [], false)
      const startedAt = Date.now()
      await expect(process.start()).rejects.toThrow(
        /exited \(code 1\) before passing verifyReady/
      )
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    })

    describe("startupFailureDetail", () => {
      /** FakeProcess whose failure detail is a fixed marker (or a throwing probe). */
      class DetailProcess extends FakeProcess {
        constructor(
          label: string,
          exePath: string,
          argv: string[],
          private readonly detail: () => Promise<string>
        ) {
          super(manager, label, exePath, argv, false)
        }
        protected override startupFailureDetail(): Promise<string> {
          return this.detail()
        }
      }

      it("is appended to the exit-before-ready rejection", async () => {
        const process = new DetailProcess("detail-exit", "/bin/false", [], () =>
          Promise.resolve("DETAIL-MARKER: holder pid 4242")
        )
        await expect(process.start()).rejects.toThrow(
          /exited \(code 1\)[\s\S]*DETAIL-MARKER: holder pid 4242/
        )
      })

      it("is appended to the verify-timeout rejection", async () => {
        const process = new DetailProcess(
          "detail-timeout",
          "/bin/sleep",
          ["5"],
          () => Promise.resolve("DETAIL-MARKER: still booting")
        )
        await expect(process.start()).rejects.toThrow(
          /did not pass verifyReady within[\s\S]*DETAIL-MARKER: still booting/
        )
        await process.kill()
      })

      it("a throwing detail probe never masks the primary error", async () => {
        const process = new DetailProcess("detail-throws", "/bin/false", [], () =>
          Promise.reject(new Error("probe exploded"))
        )
        await expect(process.start()).rejects.toThrow(
          /exited \(code 1\) before passing verifyReady/
        )
      })
    })
  })
})
