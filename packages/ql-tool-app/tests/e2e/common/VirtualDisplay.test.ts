import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import Fs from "node:fs"
import Path from "node:path"

import { TempDirectory } from "../../common/TempDirectory.js"
import { VirtualDisplay, VirtualDisplayKind, type VirtualDisplayRecord } from "./VirtualDisplay.js"

/** A stand-in X server: a Node process that idles until signalled. */
const IdleScript = "setInterval(() => {}, 1000)"
/** Display numbers used as command-line tokens only (outside the real 90–199 search range; no socket is created). */
const StandInDisplayNumber = 250
/** A second stand-in display (the pid-reuse case). */
const OtherDisplayNumber = 251

/** Every child a test spawns — reaped (and awaited) in afterEach, never unref'd. */
const children: ChildProcess[] = []

/**
 * Spawn a tracked child.
 *
 * @param args - `process.execPath` arguments.
 * @param stdin - Whether stdin is a pipe (the watchdog's lifetime pipe) or ignored.
 * @returns The child.
 */
function spawnTracked(args: string[], stdin: boolean): ChildProcess {
  const child = spawn(process.execPath, args, { stdio: [stdin ? "pipe" : "ignore", "pipe", "inherit"] })
  children.push(child)
  return child
}

/**
 * The stand-in server's command line for display `number` (names `Xvfb` and `:<number>`).
 *
 * @param number - Display number.
 * @returns `[executable, ...args]`.
 */
function standInServer(number: number): string[] {
  return [process.execPath, "-e", IdleScript, VirtualDisplay.ServerCommands[VirtualDisplayKind.xvfb], `:${number}`]
}

/**
 * Start the real watchdog over a stand-in server.
 *
 * @param number - Display number token.
 * @returns The watchdog and the server pid it reported.
 */
async function startWatchdog(number: number): Promise<[ChildProcess, number]> {
  const watchdog = spawnTracked([VirtualDisplay.WatchdogFile, ...standInServer(number)], true)
  return [watchdog, await VirtualDisplay.readServerPid(watchdog)]
}

/**
 * Wait for a child's exit.
 *
 * @param child - The child.
 * @returns `[code, signal]`.
 */
async function exitOf(child: ChildProcess): Promise<[number, NodeJS.Signals]> {
  if (VirtualDisplay.hasExited(child)) return [child.exitCode, child.signalCode]
  return (await once(child, "exit")) as [number, NodeJS.Signals]
}

/**
 * A record for display `number`.
 *
 * @param number - Display number.
 * @param watchdogPid - Watchdog pid.
 * @param serverPid - Server pid.
 * @returns The record.
 */
function recordOf(number: number, watchdogPid: number, serverPid: number): VirtualDisplayRecord {
  return { kind: VirtualDisplayKind.xvfb, number, watchdogPid, serverPid }
}

/** A new record-file path in a `TempDirectory` (removed after the suite by jest.afterEnv.ts). */
function newRecordFile(): string {
  return Path.join(TempDirectory.create(), "test-results", VirtualDisplay.RecordFilename)
}

afterEach(async () => {
  const running = children.splice(0)
  running.filter(child => !VirtualDisplay.hasExited(child)).forEach(child => child.kill("SIGKILL"))
  await Promise.all(running.map(exitOf))
})

/** The watchdog module's exported tables. */
interface WatchdogModule {
  Signal: Readonly<Record<string, string>>
  TerminationSignals: readonly string[]
}

describe("displayWatchdog.cjs", () => {
  it("names its signals through a frozen identity table; termination signals come from it", () => {
    const { Signal, TerminationSignals } = require(VirtualDisplay.WatchdogFile) as WatchdogModule
    expect(Object.isFrozen(Signal)).toBe(true)
    Object.entries(Signal).forEach(([key, value]) => expect(value).toBe(key))
    expect(TerminationSignals).toEqual([Signal.SIGTERM, Signal.SIGINT, Signal.SIGHUP])
  })

  it("reports the server pid, and stdin EOF (parent gone) stops the server before the watchdog exits 0", async () => {
    const [watchdog, serverPid] = await startWatchdog(StandInDisplayNumber),
      record = recordOf(StandInDisplayNumber, watchdog.pid, serverPid)
    expect(VirtualDisplay.isRecordedProcess(VirtualDisplay.commandLineOf(serverPid), record)).toBe(true)
    watchdog.stdin.end()
    expect(await exitOf(watchdog)).toEqual([0, null])
    expect(VirtualDisplay.commandLineOf(serverPid)).toBe("")
  })

  it("a termination signal stops the server too", async () => {
    const [watchdog, serverPid] = await startWatchdog(StandInDisplayNumber)
    watchdog.kill("SIGTERM")
    expect(await exitOf(watchdog)).toEqual([0, null])
    expect(VirtualDisplay.commandLineOf(serverPid)).toBe("")
  })

  it("exits with the server's code when the server dies unprompted", async () => {
    const watchdog = spawnTracked([VirtualDisplay.WatchdogFile, process.execPath, "-e", "process.exit(7)"], true)
    await VirtualDisplay.readServerPid(watchdog)
    expect(await exitOf(watchdog)).toEqual([7, null])
  })

  it("exits 2 without a server command, which readServerPid reports as a startup failure", async () => {
    const watchdog = spawnTracked([VirtualDisplay.WatchdogFile], true)
    await expect(VirtualDisplay.readServerPid(watchdog)).rejects.toThrow(/exited before starting the server/)
    expect(await exitOf(watchdog)).toEqual([2, null])
  })
})

describe("VirtualDisplay.stopWatchdog", () => {
  it("closes the lifetime pipe and awaits the watchdog (and so the server)", async () => {
    const [watchdog, serverPid] = await startWatchdog(StandInDisplayNumber)
    await VirtualDisplay.stopWatchdog(watchdog)
    expect(VirtualDisplay.hasExited(watchdog)).toBe(true)
    expect(VirtualDisplay.commandLineOf(serverPid)).toBe("")
  })

  it("is a no-op for an exited watchdog", async () => {
    const watchdog = spawnTracked([VirtualDisplay.WatchdogFile], true)
    await exitOf(watchdog)
    await expect(VirtualDisplay.stopWatchdog(watchdog)).resolves.toBeUndefined()
  })
})

describe("VirtualDisplay.isRecordedProcess", () => {
  const record = recordOf(93, 1, 2)

  it("matches the recorded server executable on the recorded display (server and watchdog lines)", () => {
    expect(VirtualDisplay.isRecordedProcess("Xvfb :93 -screen 0 1600x1000x24 -nolisten tcp", record)).toBe(true)
    expect(VirtualDisplay.isRecordedProcess("/usr/bin/Xvfb :93 -nolisten tcp", record)).toBe(true)
    expect(VirtualDisplay.isRecordedProcess(`/usr/bin/node ${VirtualDisplay.WatchdogFile} Xvfb :93 -screen 0`, record)).toBe(true)
    expect(VirtualDisplay.isRecordedProcess("Xephyr :93 -screen 1600x1000", { ...record, kind: VirtualDisplayKind.xephyr })).toBe(true)
  })

  it("rejects another display, another server, a zombie and a vanished pid (pid reuse is never signalled)", () => {
    expect(VirtualDisplay.isRecordedProcess("Xvfb :94 -nolisten tcp", record)).toBe(false)
    expect(VirtualDisplay.isRecordedProcess("Xephyr :93 -screen 1600x1000", record)).toBe(false)
    expect(VirtualDisplay.isRecordedProcess("[Xvfb] <defunct>", record)).toBe(false)
    expect(VirtualDisplay.isRecordedProcess("", record)).toBe(false)
  })
})

describe("VirtualDisplay.reapStale", () => {
  it("is a no-op without a record", async () => {
    expect(await VirtualDisplay.reapStale(newRecordFile())).toEqual([])
  })

  it("deletes an unreadable record without signalling anything", async () => {
    const recordFile = newRecordFile()
    Fs.mkdirSync(Path.dirname(recordFile), { recursive: true })
    Fs.writeFileSync(recordFile, "{not json")
    expect(await VirtualDisplay.reapStale(recordFile)).toEqual([])
    expect(Fs.existsSync(recordFile)).toBe(false)
  })

  it("terminates a recorded watchdog + server left by an interrupted run and deletes the record", async () => {
    const [watchdog, serverPid] = await startWatchdog(StandInDisplayNumber),
      recordFile = newRecordFile()
    VirtualDisplay.writeRecord(recordFile, recordOf(StandInDisplayNumber, watchdog.pid, serverPid))
    expect(await VirtualDisplay.reapStale(recordFile)).toEqual([watchdog.pid, serverPid])
    expect(await exitOf(watchdog)).toEqual([0, null])
    expect(VirtualDisplay.commandLineOf(serverPid)).toBe("")
    expect(Fs.existsSync(recordFile)).toBe(false)
  })

  it("SIGKILLs a recorded server whose watchdog is already gone", async () => {
    const [executable, ...args] = standInServer(StandInDisplayNumber),
      server = spawnTracked(args, false),
      recordFile = newRecordFile()
    expect(executable).toBe(process.execPath)
    await once(server, "spawn")
    VirtualDisplay.writeRecord(recordFile, recordOf(StandInDisplayNumber, 0, server.pid))
    expect(await VirtualDisplay.reapStale(recordFile)).toEqual([server.pid])
    expect((await exitOf(server))[1]).toBe("SIGTERM")
  })

  it("leaves a reused pid (command line names another display) alone", async () => {
    const [, ...args] = standInServer(OtherDisplayNumber),
      unrelated = spawnTracked(args, false),
      recordFile = newRecordFile()
    await once(unrelated, "spawn")
    VirtualDisplay.writeRecord(recordFile, recordOf(StandInDisplayNumber, unrelated.pid, unrelated.pid))
    expect(await VirtualDisplay.reapStale(recordFile)).toEqual([])
    expect(VirtualDisplay.hasExited(unrelated)).toBe(false)
    expect(Fs.existsSync(recordFile)).toBe(false)
  })
})

describe("VirtualDisplay display numbers", () => {
  it("freeDisplayNumber skips excluded and taken numbers; isTaken reads the socket and the lock file", () => {
    const first = VirtualDisplay.freeDisplayNumber()
    expect(VirtualDisplay.isTaken(first)).toBe(false)
    expect(VirtualDisplay.freeDisplayNumber([first])).toBeGreaterThan(first)
    expect(() =>
      VirtualDisplay.freeDisplayNumber(
        Array.from({ length: VirtualDisplay.LastDisplayNumber - VirtualDisplay.FirstDisplayNumber + 1 }, (_value, offset) => VirtualDisplay.FirstDisplayNumber + offset)
      )
    ).toThrow(/no free X display number/)
  })

  it("start moves to the next free number when another process took its display (a lost race), then gives up", async () => {
    const lost = new Error("server already active"),
      started = { name: "started" } as unknown as VirtualDisplay,
      kind = jest.spyOn(VirtualDisplay, "availableKind").mockReturnValue(VirtualDisplayKind.xvfb),
      taken = jest.spyOn(VirtualDisplay, "isTaken").mockReturnValue(true),
      launch = jest.spyOn(VirtualDisplay, "launch").mockRejectedValueOnce(lost).mockResolvedValueOnce(started)
    try {
      await expect(VirtualDisplay.start(newRecordFile())).resolves.toBe(started)
      const [first, second] = launch.mock.calls.map(([, number]) => number)
      expect(second).not.toBe(first)
      launch.mockReset().mockRejectedValue(lost)
      await expect(VirtualDisplay.start(newRecordFile())).rejects.toBe(lost)
      expect(launch).toHaveBeenCalledTimes(VirtualDisplay.MaxStartAttempts)
      launch.mockReset().mockRejectedValue(lost)
      taken.mockReturnValue(false)
      await expect(VirtualDisplay.start(newRecordFile())).rejects.toBe(lost)
      expect(launch).toHaveBeenCalledTimes(1)
    } finally {
      kind.mockRestore()
      taken.mockRestore()
      launch.mockRestore()
    }
  })
})
