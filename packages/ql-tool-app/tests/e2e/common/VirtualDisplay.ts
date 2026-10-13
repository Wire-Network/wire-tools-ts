import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import Fs from "node:fs"
import Path from "node:path"
import Readline from "node:readline"

import { sleep } from "@wireio/cluster-tool"
import { getValue, getLogger, NestedError } from "@wireio/shared"

const log = getLogger(__filename)

/** Which X server backs the e2e display (identity enum). */
export enum VirtualDisplayKind {
  /** A headless Xvfb server (CI, or any host with xvfb installed). */
  xvfb = "xvfb",
  /** A nested Xephyr server inside the session's DISPLAY (hosts without Xvfb). */
  xephyr = "xephyr"
}

/** What `dist/test-results/virtual-display.json` records about a running display. */
export interface VirtualDisplayRecord {
  /** The server. */
  kind: VirtualDisplayKind
  /** Display number (`:N`). */
  number: number
  /** pid of the {@link VirtualDisplay.WatchdogFile} process that owns the server. */
  watchdogPid: number
  /** pid of the X server itself. */
  serverPid: number
}

/** The watchdog's one stdout line. */
export interface VirtualDisplayWatchdogHello {
  /** pid of the spawned X server. */
  serverPid: number
}

/** A process the stale-display reaper may signal (its pid plus why it is ours). */
export interface VirtualDisplayReapTarget {
  /** The pid. */
  pid: number
  /** Which role the record gave it. */
  role: VirtualDisplayProcessRole
}

/** The two processes of one display (identity enum). */
export enum VirtualDisplayProcessRole {
  /** The lifetime watchdog. */
  watchdog = "watchdog",
  /** The X server. */
  server = "server"
}

/**
 * The X display the e2e Electron runs on. Electron's headless ozone backend
 * cannot create BrowserWindows on every GPU stack, so e2e always runs on a real
 * (virtual) X server: Xvfb when installed, else a nested Xephyr inside the
 * session's own DISPLAY. The first free display number above
 * {@link VirtualDisplay.FirstDisplayNumber} is used; displays are unix sockets
 * (`-nolisten tcp`), never TCP ports.
 *
 * Lifetime: the server is launched through {@link VirtualDisplay.WatchdogFile},
 * whose stdin pipe this process holds — when the test runner exits for any
 * reason (teardown, Ctrl-C, SIGKILL) the pipe reaches EOF and the watchdog
 * terminates and awaits the server. The running display is also recorded in a
 * JSON file so the next run's globalSetup reaps a display whose watchdog itself
 * was killed ({@link VirtualDisplay.reapStale}).
 */
export class VirtualDisplay {
  /**
   * @param kind - The server.
   * @param number - Display number.
   * @param watchdog - The watchdog process (its stdin is the lifetime pipe).
   * @param serverPid - pid of the X server.
   * @param recordFile - The pid record this display wrote.
   */
  private constructor(
    readonly kind: VirtualDisplayKind,
    readonly number: number,
    private readonly watchdog: ChildProcess,
    readonly serverPid: number,
    readonly recordFile: string
  ) {}

  /** `:N`. */
  get name(): string {
    return `:${this.number}`
  }

  /** pid of the watchdog process. */
  get watchdogPid(): number {
    return this.watchdog.pid
  }

  /**
   * Start a server on the first free display (through the watchdog) and record it.
   * A display number taken by another process between the free check and the
   * server's start (a lost race) moves on to the next free number, up to
   * {@link VirtualDisplay.MaxStartAttempts} numbers.
   *
   * @param recordFile - Where to record the running display (`dist/test-results/virtual-display.json`).
   * @returns The running display.
   * @throws NestedError when neither Xvfb nor (Xephyr + DISPLAY) is available, or the server does not come up.
   */
  static async start(recordFile: string): Promise<VirtualDisplay> {
    return VirtualDisplay.startAvoiding(VirtualDisplay.availableKind(), recordFile, [])
  }

  /**
   * Start `kind` on the first free display number not in `tried`; retry past a lost race.
   *
   * @param kind - The server.
   * @param recordFile - The pid record.
   * @param tried - Display numbers lost to another process.
   * @returns The running display.
   */
  private static async startAvoiding(kind: VirtualDisplayKind, recordFile: string, tried: number[]): Promise<VirtualDisplay> {
    const number = VirtualDisplay.freeDisplayNumber(tried),
      [command, ...args] = VirtualDisplay.serverCommandLine(kind, number)
    try {
      return await VirtualDisplay.launch(kind, number, command, args, recordFile)
    } catch (error) {
      const attempts = tried.length + 1
      if (!VirtualDisplay.isTaken(number) || attempts >= VirtualDisplay.MaxStartAttempts) throw error
      log.warn(`display :${number} was taken while it started (attempt ${attempts}); trying the next free number`, error)
      return VirtualDisplay.startAvoiding(kind, recordFile, [...tried, number])
    }
  }

  /**
   * Launch `command args` under the watchdog, wait for display `number`'s socket and record it.
   * {@link VirtualDisplay.start} picks the server; tests launch a stand-in.
   *
   * @param kind - The server kind (recorded).
   * @param number - The display number whose socket signals readiness.
   * @param command - The server executable.
   * @param args - Its arguments.
   * @param recordFile - The pid record.
   * @returns The running display.
   */
  static async launch(kind: VirtualDisplayKind, number: number, command: string, args: string[], recordFile: string): Promise<VirtualDisplay> {
    const watchdog = spawn(process.execPath, [VirtualDisplay.WatchdogFile, command, ...args], { stdio: ["pipe", "pipe", "inherit"] })
    try {
      const serverPid = await VirtualDisplay.readServerPid(watchdog)
      await VirtualDisplay.waitForSocket(number, watchdog)
      const display = new VirtualDisplay(kind, number, watchdog, serverPid, recordFile)
      VirtualDisplay.writeRecord(recordFile, { kind, number, watchdogPid: watchdog.pid, serverPid })
      log.info(`started ${kind} on ${display.name} (server pid ${serverPid}, watchdog pid ${watchdog.pid})`)
      return display
    } catch (error) {
      await VirtualDisplay.stopWatchdog(watchdog)
      throw new NestedError(`could not start ${command} on :${number}`, { cause: error, context: { command, args } })
    }
  }

  /** Stop the server: close the watchdog's lifetime pipe, AWAIT its exit (which awaits the server), drop the record. */
  async stop(): Promise<void> {
    await VirtualDisplay.stopWatchdog(this.watchdog)
    Fs.rmSync(this.recordFile, { force: true })
    log.info(`stopped ${this.kind} on ${this.name}`)
  }
}

/** Display discovery, lifetime and stale-reap helpers. */
export namespace VirtualDisplay {
  /** The X socket directory. */
  export const SocketPath = "/tmp/.X11-unix"
  /** The directory of the X lock files (`.X<N>-lock`). */
  export const LockPath = "/tmp"
  /** First display number tried. */
  export const FirstDisplayNumber = 90
  /** Last display number tried. */
  export const LastDisplayNumber = 199
  /** Xvfb screen geometry. */
  export const ScreenGeometry = "1600x1000x24"
  /** Xephyr screen size. */
  export const ScreenSize = "1600x1000"
  /** Socket wait ceiling (ms). */
  export const StartupTimeoutMs = 10_000
  /** Socket / process poll interval (ms). */
  export const PollMs = 50
  /** Display numbers tried when others are lost to a concurrent X server start. */
  export const MaxStartAttempts = 3
  /** The watchdog script (plain Node; see its header). */
  export const WatchdogFile = Path.join(__dirname, "displayWatchdog.cjs")
  /** Ceiling for the watchdog to exit after its pipe closes (above its own SIGTERM→SIGKILL grace) before it is SIGKILLed (ms). */
  export const WatchdogStopTimeoutMs = 10_000
  /** Ceiling for recorded processes to die after SIGTERM before SIGKILL, and again after SIGKILL (ms). */
  export const ReapTimeoutMs = 10_000
  /** The record's file name (in `dist/test-results/`, beside Playwright's own outputDir). */
  export const RecordFilename = "virtual-display.json"
  /** The executable of each server kind. */
  export const ServerCommands: Readonly<Record<VirtualDisplayKind, string>> = {
    [VirtualDisplayKind.xvfb]: "Xvfb",
    [VirtualDisplayKind.xephyr]: "Xephyr"
  }

  /**
   * Whether an executable is on PATH.
   *
   * @param command - Executable name.
   * @returns Whether `which` finds it.
   */
  export function hasCommand(command: string): boolean {
    return spawnSync("which", [command], { stdio: "ignore" }).status === 0
  }

  /**
   * The server this host can run.
   *
   * @returns Xvfb, else Xephyr (needs a session DISPLAY).
   * @throws NestedError when neither is possible.
   */
  export function availableKind(): VirtualDisplayKind {
    if (hasCommand(ServerCommands[VirtualDisplayKind.xvfb])) return VirtualDisplayKind.xvfb
    if (hasCommand(ServerCommands[VirtualDisplayKind.xephyr]) && process.env.DISPLAY != null) return VirtualDisplayKind.xephyr
    throw new NestedError("e2e needs an X server: install xvfb (or run inside a desktop session with Xephyr)", {
      context: { display: process.env.DISPLAY }
    })
  }

  /**
   * The server's command line for display `number`.
   *
   * @param kind - The server.
   * @param number - Display number.
   * @returns `[executable, ...args]`.
   */
  export function serverCommandLine(kind: VirtualDisplayKind, number: number): string[] {
    const display = `:${number}`
    return kind === VirtualDisplayKind.xvfb
      ? [ServerCommands[kind], display, "-screen", "0", ScreenGeometry, "-nolisten", "tcp"]
      : [ServerCommands[kind], display, "-screen", ScreenSize, "-nolisten", "tcp", "-no-host-grab"]
  }

  /**
   * Whether display `number` is in use: its socket or its lock file exists.
   *
   * @param number - Display number.
   * @returns True when taken.
   */
  export function isTaken(number: number): boolean {
    return Fs.existsSync(Path.join(SocketPath, `X${number}`)) || Fs.existsSync(Path.join(LockPath, `.X${number}-lock`))
  }

  /**
   * The first display number with neither a socket nor a lock file, skipping `excluded`.
   *
   * @param excluded - Numbers not to use (lost to another process).
   * @returns The number.
   */
  export function freeDisplayNumber(excluded: readonly number[] = []): number {
    const found = Array.from({ length: LastDisplayNumber - FirstDisplayNumber + 1 }, (_value, offset) => FirstDisplayNumber + offset).find(
      number => !excluded.includes(number) && !isTaken(number)
    )
    if (found == null) throw new NestedError("no free X display number", { context: { FirstDisplayNumber, LastDisplayNumber, excluded } })
    return found
  }

  /**
   * The server pid the watchdog reports on its first stdout line.
   *
   * @param watchdog - The watchdog process.
   * @returns The server pid.
   * @throws NestedError when the watchdog exits before reporting.
   */
  export async function readServerPid(watchdog: ChildProcess): Promise<number> {
    const lines = Readline.createInterface({ input: watchdog.stdout }),
      abort = new AbortController()
    try {
      const [line] = (await Promise.race([
        once(lines, "line", { signal: abort.signal }),
        once(watchdog, "exit", { signal: abort.signal }).then(([code, signal]) => {
          throw new NestedError("the display watchdog exited before starting the server", { context: { code, signal } })
        })
      ])) as string[]
      return (JSON.parse(line) as VirtualDisplayWatchdogHello).serverPid
    } finally {
      abort.abort()
      lines.close()
    }
  }

  /**
   * Wait until the display's socket exists (fails fast when the watchdog — hence the server — already exited).
   *
   * @param number - Display number.
   * @param watchdog - The watchdog process.
   */
  export async function waitForSocket(number: number, watchdog: ChildProcess): Promise<void> {
    const socket = Path.join(SocketPath, `X${number}`),
      deadline = Date.now() + StartupTimeoutMs
    while (!Fs.existsSync(socket)) {
      if (hasExited(watchdog)) throw new NestedError(`X display :${number} exited during startup`, { context: { exitCode: watchdog.exitCode } })
      if (Date.now() > deadline) throw new NestedError(`X display :${number} did not start`, { context: { socket } })
      await sleep(PollMs)
    }
  }

  /**
   * Whether a child already exited.
   *
   * @param child - The child.
   * @returns True once it has an exit code or signal.
   */
  export function hasExited(child: ChildProcess): boolean {
    return child.exitCode != null || child.signalCode != null
  }

  /**
   * Stop a watchdog: end its stdin (the lifetime pipe) and AWAIT its exit; SIGKILL it past
   * {@link WatchdogStopTimeoutMs}. The race timer is cleared on settle.
   *
   * @param watchdog - The watchdog process.
   */
  export async function stopWatchdog(watchdog: ChildProcess): Promise<void> {
    if (hasExited(watchdog)) return
    const exited = once(watchdog, "exit")
    watchdog.stdin.end()
    let escalation: ReturnType<typeof setTimeout> = null
    const timer = new Promise<boolean>(resolve => {
      escalation = setTimeout(() => resolve(false), WatchdogStopTimeoutMs)
    })
    const stopped = await Promise.race([exited.then(() => true), timer]).finally(() => clearTimeout(escalation))
    if (stopped) return
    log.warn(`display watchdog ${watchdog.pid} ignored its closed pipe; SIGKILL`)
    watchdog.kill("SIGKILL")
    await exited
  }

  /**
   * Write the record of a running display (creating its directory).
   *
   * @param recordFile - The record file.
   * @param record - The display.
   */
  export function writeRecord(recordFile: string, record: VirtualDisplayRecord): void {
    Fs.mkdirSync(Path.dirname(recordFile), { recursive: true })
    Fs.writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`)
  }

  /**
   * The command line of a live process (`ps -o args=`), or "" when no such process exists.
   *
   * @param pid - The pid.
   * @returns Its command line.
   */
  export function commandLineOf(pid: number): string {
    const result = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" })
    return result.status === 0 ? result.stdout.trim() : ""
  }

  /**
   * Whether a command line belongs to the recorded display — it names the recorded server
   * executable AND the recorded display — so a pid the kernel has since reused for an
   * unrelated process is never signalled. A zombie (`[Xvfb] <defunct>`) does not match.
   *
   * @param commandLine - `ps -o args=` output.
   * @param record - The display record.
   * @returns True for the recorded watchdog or server.
   */
  export function isRecordedProcess(commandLine: string, record: VirtualDisplayRecord): boolean {
    const tokens = commandLine.split(/\s+/).filter(token => token.length > 0)
    return tokens.includes(`:${record.number}`) && tokens.some(token => Path.basename(token) === ServerCommands[record.kind])
  }

  /**
   * The recorded processes that are still alive and still ours.
   *
   * @param record - The display record.
   * @returns Watchdog first, then server.
   */
  export function liveTargets(record: VirtualDisplayRecord): VirtualDisplayReapTarget[] {
    const targets: VirtualDisplayReapTarget[] = [
      { pid: record.watchdogPid, role: VirtualDisplayProcessRole.watchdog },
      { pid: record.serverPid, role: VirtualDisplayProcessRole.server }
    ]
    return targets.filter(({ pid }) => Number.isInteger(pid) && pid > 0 && isRecordedProcess(commandLineOf(pid), record))
  }

  /**
   * Signal targets, ignoring a process that died in between.
   *
   * @param targets - The processes.
   * @param signal - The signal.
   */
  export function signalAll(targets: VirtualDisplayReapTarget[], signal: NodeJS.Signals): void {
    targets.forEach(({ pid }) => guardKill(pid, signal))
  }

  /**
   * Wait until no recorded process is alive, up to `timeoutMs`.
   *
   * @param record - The display record.
   * @param timeoutMs - Ceiling.
   * @returns The survivors (empty when all died).
   */
  export async function waitForDeath(record: VirtualDisplayRecord, timeoutMs: number): Promise<VirtualDisplayReapTarget[]> {
    const deadline = Date.now() + timeoutMs
    let survivors = liveTargets(record)
    while (survivors.length > 0 && Date.now() <= deadline) {
      await sleep(PollMs)
      survivors = liveTargets(record)
    }
    return survivors
  }

  /**
   * Reap the display an interrupted previous run recorded: SIGTERM its watchdog and server
   * (the watchdog stops the server itself), SIGKILL whatever survives {@link ReapTimeoutMs},
   * and delete the record. Processes whose command line no longer matches the record (pid
   * reuse) are left alone. No record (or an unreadable one) is a no-op apart from deleting it.
   *
   * @param recordFile - The record file.
   * @returns The pids that were signalled.
   * @throws NestedError when a recorded process survives SIGKILL.
   */
  export async function reapStale(recordFile: string): Promise<number[]> {
    if (!Fs.existsSync(recordFile)) return []
    const record = getValue(() => JSON.parse(Fs.readFileSync(recordFile, "utf8")) as VirtualDisplayRecord, null),
      targets = record == null ? [] : liveTargets(record)
    if (targets.length > 0) {
      log.warn(`reaping a stale ${record.kind} display :${record.number} left by an interrupted run (pids ${targets.map(({ pid }) => pid).join(", ")})`)
      signalAll(targets, "SIGTERM")
      const survivors = await waitForDeath(record, ReapTimeoutMs)
      signalAll(survivors, "SIGKILL")
      const undead = await waitForDeath(record, ReapTimeoutMs)
      if (undead.length > 0) throw new NestedError("a stale e2e display survived SIGKILL", { context: { record, undead } })
    }
    Fs.rmSync(recordFile, { force: true })
    return targets.map(({ pid }) => pid)
  }

  /**
   * `process.kill` that tolerates a process that is already gone (ESRCH).
   *
   * @param pid - The pid.
   * @param signal - The signal.
   */
  function guardKill(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
}
