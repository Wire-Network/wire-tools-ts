import Fs from "node:fs"
import Os from "node:os"
import Path from "node:path"
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process"
import { PassThrough, Readable } from "node:stream"
import { ProcessSignalName } from "@wireio/cluster-tool-shared"
import { Deferred, guard } from "@wireio/shared"
import {
  ManagedProcess,
  ProcessManager,
  terminatePidsSync
} from "@wireio/cluster-tool/cluster/processes"

/** Loaded-host ceiling for a local bash readiness / close event; never a fixed delay. */
const StragglerEventTimeoutMs = 20_000
/** Install SIGINT handling before readiness, then tie lifetime to the parent's stdin pipe. */
const StragglerCommand = "trap '' INT; echo ready; read -r _"

/** Bound a child event wait and clear the watchdog on every settlement path. */
function waitForChildEvent(event: Promise<void>, label: string): Promise<void> {
  let handle: NodeJS.Timeout
  const timeout = Deferred.useCallback<void>(deferred => {
    handle = setTimeout(
      () =>
        deferred.reject(
          new Error(
            `${label} did not arrive within ${StragglerEventTimeoutMs}ms`
          )
        ),
      StragglerEventTimeoutMs
    )
  }).promise
  return Promise.race([event, timeout]).finally(() => clearTimeout(handle))
}

/** Own the directly spawned straggler independently of the termination behavior under test. */
async function withStragglerChild(
  body: (child: ChildProcessWithoutNullStreams) => Promise<void>
): Promise<void> {
  const child = spawn("/bin/bash", ["-c", StragglerCommand], { stdio: "pipe" }),
    closed = Deferred.useCallback<void>(deferred => {
      // Register before readiness: exitCode is set before stdio has closed.
      child.once("close", () => deferred.resolve())
    }).promise,
    ready = new Deferred<void>(),
    onReady = () => ready.resolve(),
    onError = (error: Error) => ready.reject(error),
    onExit = (code: number, signal: NodeJS.Signals) =>
      ready.reject(
        new Error(
          `straggler exited before ready (code=${code}, signal=${signal})`
        )
      )
  child.stdout.once("data", onReady)
  child.once("error", onError)
  child.once("exit", onExit)
  child.stderr.resume()
  try {
    try {
      await waitForChildEvent(ready.promise, "straggler readiness")
    } finally {
      child.stdout.removeListener("data", onReady)
      child.removeListener("error", onError)
      child.removeListener("exit", onExit)
    }
    await body(child)
    await waitForChildEvent(closed, "straggler close")
  } finally {
    // Use the child handle, never the sweep's liveness predicate or returned pids.
    if (child.exitCode == null && child.signalCode == null) {
      child.kill(ProcessSignalName.SIGKILL)
    }
    child.stdin.destroy()
    await waitForChildEvent(closed, "straggler cleanup close")
  }
}

describe("straggler fixture lifecycle", () => {
  afterEach(() => jest.useRealTimers())

  it("clears the event watchdog on success", async () => {
    jest.useFakeTimers()
    await waitForChildEvent(Promise.resolve(), "ready")
    expect(jest.getTimerCount()).toBe(0)
  })

  it("preserves event errors and clears the watchdog", async () => {
    jest.useFakeTimers()
    const error = new Error("spawn failed")
    await expect(
      waitForChildEvent(Promise.reject(error), "ready")
    ).rejects.toBe(error)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("bounds a missing event without leaving a timer", async () => {
    jest.useFakeTimers()
    const pending = new Deferred<void>(),
      wait = waitForChildEvent(pending.promise, "ready")
    jest.advanceTimersByTime(StragglerEventTimeoutMs)
    await expect(wait).rejects.toThrow(
      `ready did not arrive within ${StragglerEventTimeoutMs}ms`
    )
    expect(jest.getTimerCount()).toBe(0)
  })

  it("kills and reaps the child even when the test body throws", async () => {
    let child: ChildProcessWithoutNullStreams
    let closed = false
    const error = new Error("termination assertion failed")
    await expect(
      withStragglerChild(async spawned => {
        child = spawned
        spawned.once("close", () => {
          closed = true
        })
        throw error
      })
    ).rejects.toBe(error)
    expect(closed).toBe(true)
    expect(child.signalCode).toBe(ProcessSignalName.SIGKILL)
    expect(child.stdin.destroyed).toBe(true)
  })
})

/** A concrete ManagedProcess for tests — trivial exe, fast verify window. */
class FakeProcess extends ManagedProcess {
  constructor(
    manager: ProcessManager,
    label: string,
    private readonly exePath = "/bin/true",
    private readonly argv: string[] = [],
    private readonly ready = true,
    private readonly verifyBudgetMs = FakeProcess.VerifyTimeoutMs
  ) {
    super(manager, { label, kind: ManagedProcess.Kind.anvil })
  }
  get exe(): string {
    return this.exePath
  }
  get args(): string[] {
    return this.argv
  }
  verifyReady(): Promise<boolean> {
    return Promise.resolve(this.ready)
  }
  protected get verifyTimeoutMs(): number {
    return this.verifyBudgetMs
  }
  protected get verifyIntervalMs(): number {
    return 10
  }
  /** Public wrapper so the test can drive the protected captureOutput. */
  capture(stream: NodeJS.ReadableStream, isErr = false): void {
    this.captureOutput(stream, isErr)
  }
}

namespace FakeProcess {
  /** Verify window for cases that EXPECT the verify timeout — kept short so they fail fast. */
  export const VerifyTimeoutMs = 50
  /**
   * Verify window for a child that dies before ready. `exited` settles on the
   * child's `close`, which a loaded host can deliver well after 50ms — so a
   * short window would race the death and report the timeout instead. This
   * window is long enough that only the exit-before-ready path can end the
   * verify loop, and still below jest's 30s test timeout.
   */
  export const ExitBeforeReadyVerifyTimeoutMs = 20_000
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

  it("initialize() runs the one-time orphan sweep directly, before any process is pushed", () => {
    // Nothing has been pushed yet — the sweep seeded in beforeAll (a live
    // managed-basename orphan pid + an unmanaged pidfile) only runs if
    // initialize() itself triggers ensureInitialized(), not the lazy push path.
    manager.initialize()
    expect(commandBasename(orphanPid)).toBe("")
    expect(Fs.existsSync(unmanagedPidFile)).toBe(false)
    // A second call is idempotent — no re-sweep, no re-registered handlers.
    expect(() => manager.initialize()).not.toThrow()
  })

  it("self-registers in the constructor (inverted ownership)", () => {
    const managed = new FakeProcess(manager, "self-reg")
    expect(manager.get("self-reg")).toBe(managed)
  })

  it("the first push swept the cluster's own managed orphan pid", () => {
    // Armed by the FakeProcess above: SIGINT → poll for exit (up to
    // SweepGraceMs) → SIGKILL stragglers. The child zombifies under jest
    // (unreaped), so assert the sweep's own liveness semantics: it no longer
    // runs the managed binary.
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
    const managed = new FakeProcess(
      manager,
      "timer-hygiene",
      "/usr/bin/sleep",
      ["300"]
    )
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
      const managed = new FakeProcess(manager, "rm-running", "/usr/bin/sleep", [
        "300"
      ])
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

  it.each([false, true])(
    "frames transaction traces across pipe chunks (stderr=%s)",
    async isErr => {
      const process = new FakeProcess(manager, "trace-chunks"),
        stream = new PassThrough(),
        writeSpy = jest.spyOn(manager, "writeRaw"),
        trace = '[TRX_TRACE] {"id":"payment","action_traces":[]}'
      process.capture(stream, isErr)
      stream.write(trace.slice(0, 20))
      expect(writeSpy).not.toHaveBeenCalled()
      stream.write(trace.slice(20) + "\r")
      stream.end("\n\nfinal diagnostic")
      await Deferred.useCallback<void>(deferred =>
        stream.once("end", () => deferred.resolve())
      ).promise
      expect(writeSpy.mock.calls).toEqual([
        ["trace-chunks", trace],
        ["trace-chunks", "final diagnostic"]
      ])
      expect(process.recentOutput).toEqual([trace, "final diagnostic"])
      writeSpy.mockRestore()
    }
  )

  it.each([
    ["U+2028", " "],
    ["U+2029", " "],
    ["a bare CR", "\r"]
  ])("keeps %s inside a captured line", async (_name, separator) => {
    const process = new FakeProcess(manager, "trace-separator"),
      stream = new PassThrough(),
      writeSpy = jest.spyOn(manager, "writeRaw"),
      line = `[TRX_TRACE] {"console":"before${separator}after"}`
    process.capture(stream)
    stream.end(`${line}\n`)
    await Deferred.useCallback<void>(deferred =>
      stream.once("end", () => deferred.resolve())
    ).promise
    expect(writeSpy.mock.calls).toEqual([["trace-separator", line]])
    expect(process.recentOutput).toEqual([line])
    writeSpy.mockRestore()
  })

  describe("recentOutput", () => {
    it("retains captured lines in order", async () => {
      const process = new FakeProcess(manager, "recent-order")
      const stream = Readable.from(["alpha\nbeta\n", "gamma\n"])
      process.capture(stream)
      await new Promise<void>(resolve => stream.once("end", () => resolve()))
      expect(process.recentOutput).toEqual(["alpha", "beta", "gamma"])
    })

    it("caps retention at RecentOutputCap, dropping the oldest lines", async () => {
      const process = new FakeProcess(manager, "recent-cap")
      const overflow = 5
      const lines = Array.from(
        { length: ManagedProcess.RecentOutputCap + overflow },
        (_, index) => `line-${index}`
      )
      const stream = Readable.from([lines.join("\n") + "\n"])
      process.capture(stream)
      await new Promise<void>(resolve => stream.once("end", () => resolve()))
      expect(process.recentOutput).toHaveLength(ManagedProcess.RecentOutputCap)
      expect(process.recentOutput[0]).toBe(`line-${overflow}`)
      expect(process.recentOutput[process.recentOutput.length - 1]).toBe(
        `line-${lines.length - 1}`
      )
    })
  })

  describe("terminatePidsSync", () => {
    /** The sweep's own liveness semantics — zombies (empty cmdline) count as exited. */
    const isAliveByCmdline = (pid: number): boolean =>
      commandBasename(pid) !== ""

    it("returns [] without signalling when nothing passes isAlive", () => {
      const killSpy = jest.spyOn(process, "kill")
      try {
        expect(terminatePidsSync([987_654], 1_000, () => false)).toEqual([])
        expect(killSpy).not.toHaveBeenCalledWith(987_654, expect.anything())
      } finally {
        killSpy.mockRestore()
      }
    })

    it("waits for a graceful exit and returns [] well inside the grace window", async () => {
      const { spawn } = await import("node:child_process")
      const child = spawn("/bin/sleep", ["300"], { stdio: "ignore" })
      const startedAt = Date.now()
      const forced = terminatePidsSync([child.pid], 10_000, isAliveByCmdline)
      expect(forced).toEqual([])
      // The poll returns as soon as the pid is gone — nowhere near the 10s cap.
      expect(Date.now() - startedAt).toBeLessThan(5_000)
      expect(isAliveByCmdline(child.pid)).toBe(false)
    })

    it("SIGKILLs a straggler that ignores the graceful signal and reports it", async () => {
      // Wait for the child's own readiness line — it is printed AFTER the trap
      // is installed — or the SIGINT lands early and the child exits
      // gracefully, leaving the straggler path untested. bash then blocks in the
      // `read` builtin on the open stdin pipe: no grandchild to outlive the
      // SIGKILL, and no exec (during which /proc/<pid>/cmdline is briefly
      // empty, which the liveness check reads as an exited process).
      let pid: number
      await withStragglerChild(async child => {
        pid = child.pid
        const forced = terminatePidsSync([pid], 1_200, isAliveByCmdline)
        expect(forced).toEqual([pid])
      })
      // withStragglerChild awaited close; the kernel has reaped the process.
      expect(isAliveByCmdline(pid)).toBe(false)
    })
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
      const process = new FakeProcess(
        manager,
        "never",
        "/bin/sleep",
        ["5"],
        false
      )
      await expect(process.start()).rejects.toThrow(/did not pass verifyReady/)
      await process.kill()
    })

    it("fails FAST with the exit code when the child dies before ready (crash ≠ slow boot)", async () => {
      // /bin/false exits immediately with code 1; verifyReady never passes.
      // The verify loop must surface the death + exit code well inside the
      // budget instead of burning it and reporting the generic timeout line
      // (a crashed daemon and a slow boot must be distinguishable from the
      // failure message alone).
      const process = new FakeProcess(
        manager,
        "dies",
        "/bin/false",
        [],
        false,
        FakeProcess.ExitBeforeReadyVerifyTimeoutMs
      )
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
          private readonly detail: () => Promise<string>,
          verifyBudgetMs = FakeProcess.VerifyTimeoutMs
        ) {
          super(manager, label, exePath, argv, false, verifyBudgetMs)
        }
        protected override startupFailureDetail(): Promise<string> {
          return this.detail()
        }
      }

      it("is appended to the exit-before-ready rejection", async () => {
        const process = new DetailProcess(
          "detail-exit",
          "/bin/false",
          [],
          () => Promise.resolve("DETAIL-MARKER: holder pid 4242"),
          FakeProcess.ExitBeforeReadyVerifyTimeoutMs
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
        const process = new DetailProcess(
          "detail-throws",
          "/bin/false",
          [],
          () => Promise.reject(new Error("probe exploded")),
          FakeProcess.ExitBeforeReadyVerifyTimeoutMs
        )
        await expect(process.start()).rejects.toThrow(
          /exited \(code 1\) before passing verifyReady/
        )
      })
    })
  })
})
