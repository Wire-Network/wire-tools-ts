import Path from "path"
import Fs from "fs"
import {
  spawn,
  execFileSync,
  type ChildProcess,
  type StdioOptions
} from "child_process"
import treeKill from "tree-kill"
import { log } from "../logger.js"
import { Deferred, isDefined } from "@wireio/shared"
import { asOption, Either } from "@3fv/prelude-ts"
import { ProcessSignalName } from "./ProcessSignals.js"
import * as Assert from "node:assert"
import { mkdirs } from "../util.js"
import { identity } from "lodash"

const GracefulKillMs = 2_000
const ChildStdio: StdioOptions = ["ignore", "pipe", "pipe"]

/**
 * Static configuration for a process launched by {@link ProcessManager}.
 */
export interface ProcessConfig {
  /** Human-readable label — used as the process key, log prefix, and pid file name. */
  label: string
  /** Path to the executable (or name on $PATH). */
  command: string
  /** Command-line arguments. */
  args: string[]
  /** Working directory. */
  cwd?: string
  /** Environment variables (merged onto `process.env`). */
  env?: Record<string, string>
  /** Optional dedicated log file path; if unset the default per-process log is used. */
  logFile?: string
  /**
   * Optional verification callback invoked after spawn.
   * Called repeatedly until it returns true or the timeout expires.
   * Use this to wait for a process to reach a ready/synced state.
   */
  verifyCallback?: (handle: ProcessHandle) => Promise<boolean>
  /** Timeout for `verifyCallback` polling (default: 60_000ms). */
  verifyTimeoutMs?: number
  /** Interval between `verifyCallback` polls (default: 15_000ms). */
  verifyIntervalMs?: number
}

/**
 * Live handle to a spawned process tracked by {@link ProcessManager}.
 */
export interface ProcessHandle {
  /** Monotonic id assigned by the manager (unique within the manager's lifetime). */
  id: number
  /** Operating-system pid. */
  pid: number
  /** Absolute path to the pid file written on spawn and removed on exit/kill. */
  pidFile: string
  /** Kill the process (SIGTERM → escalate to SIGKILL on timeout) and wait for exit. */
  kill(): Promise<void>
  /** Resolve with the exit code once the process has exited. */
  wait(): Promise<number>
}

/** Process names to sweep at startup and on exit. */
const ManagedProcessNames = [
  "nodeop",
  "kiod",
  "anvil",
  "solana-test-validator"
] as const

type ManagedProcessName = (typeof ManagedProcessNames)[number]

/** Format a YYYYMMDD timestamp used in log file names. */
function currentDateStamp(date: Date = new Date()): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
}

/** Check if a process with the given name is running via `pgrep`. */
function isProcessRunning(name: ManagedProcessName): boolean {
  return Either.try(() =>
    execFileSync("pgrep", ["-x", name], { stdio: "ignore" })
  ).match({
    Left: () => false,
    Right: () => true
  })
}

/** Send a signal to all processes matching `name` via `pkill`. */
function pkill(
  name: ManagedProcessName,
  signal: ProcessSignalName = ProcessSignalName.SIGTERM
): boolean {
  return Either.try(() =>
    execFileSync("pkill", ["-x", name], { stdio: "ignore" })
  ).match({
    Left: err => {
      log.debug(`Failed to kill process ${name} with signal ${signal}`, err)
      return false
    },
    Right: () => true
  })
}

/** Kill an individual pid (and its subtree) asynchronously via `tree-kill`. */
function treeKillAsync(pid: number, signal: ProcessSignalName): Promise<void> {
  return Deferred.useCallback<void>(d =>
    treeKill(pid, signal, err => (err ? d.reject(err) : d.resolve()))
  ).promise
}

/**
 * Kill any existing instances of managed processes.
 * Sends SIGTERM first, waits {@link GracefulKillMs}, then SIGKILL for stragglers.
 */
function killExistingProcesses(): void {
  const running = ManagedProcessNames.filter(isProcessRunning)
  if (running.length === 0) return

  log.info(`Killing existing processes: ${running.join(", ")}`)
  running.forEach(name => pkill(name))

  execFileSync("sleep", [String(GracefulKillMs / 1000)])

  const stragglers = running.filter(isProcessRunning)
  if (stragglers.length > 0) {
    log.warn(`Force-killing stragglers: ${stragglers.join(", ")}`)
    stragglers.forEach(name => pkill(name, ProcessSignalName.SIGKILL))
  }
}

/**
 * Process manager backed directly by `child_process.spawn`.
 *
 * On first use, kills any existing `nodeop` / `kiod` / `anvil` /
 * `solana-test-validator` processes at the OS level (pkill) to clear orphans
 * from a previous run. Registers exit handlers so that all managed processes
 * are stopped and pid files are cleaned up when the tool exits.
 */
export class ProcessManager {
  private static clusterPath: string

  private static instance: ProcessManager

  /**
   * Set the cluster root path. Must be called exactly once per tool lifetime
   * (idempotent when called with the same value).
   */
  static setClusterPath(clusterPath: string): typeof ProcessManager {
    Assert.ok(
      !this.clusterPath || this.clusterPath === clusterPath,
      `Cluster Path can only be set once (currentValue=${this.clusterPath},newValue=${clusterPath}`
    )
    this.clusterPath = clusterPath
    return this
  }

  /** Singleton accessor. {@link setClusterPath} must have been called first. */
  static get(): ProcessManager {
    Assert.ok(
      !!this.clusterPath,
      `Cluster Path must be set before getting the process manager`
    )
    if (!this.instance) {
      this.instance = new ProcessManager()
    }
    return this.instance
  }

  /** Join children onto the cluster root path. */
  static toClusterPath(...children: string[]): string {
    return Path.join(ProcessManager.clusterPath, ...children)
  }

  private handles: Map<string, ProcessHandle> = new Map()
  private children: Map<string, ChildProcess> = new Map()
  private initialized = false
  private nextId = 0

  private clusterLogStream: Fs.WriteStream = null
  private processLogStreams: Map<string, Fs.WriteStream> = new Map()
  private exitHandlerRegistered = false

  private constructor() {}

  /** One-time startup: sweep orphans and register exit handlers. */
  private ensureInitialized(): void {
    if (this.initialized) return
    killExistingProcesses()
    this.initialized = true
    this.registerExitHandler()
  }

  /** Register process exit handlers to clean up managed processes. */
  private registerExitHandler(): void {
    if (this.exitHandlerRegistered) return
    this.exitHandlerRegistered = true

    const cleanup = () => {
      log.info("ProcessManager: cleaning up on exit...")
      ManagedProcessNames.forEach(name => pkill(name))
      this.handles.forEach(h => {
        try {
          Fs.rmSync(h.pidFile, { force: true })
        } catch {
          /* ignore */
        }
      })
      this.closeAllLogStreams()
    }

    process.on("exit", cleanup)
    process.on(ProcessSignalName.SIGINT, () => {
      cleanup()
      process.exit(130)
    })
    process.on(ProcessSignalName.SIGTERM, () => {
      cleanup()
      process.exit(143)
    })
  }

  private toProcessPath(label: string, ...children: string[]): string {
    return ProcessManager.toClusterPath(
      "data",
      label.replaceAll("-", "_"),
      ...children
    )
  }
  /**
   * Map a process label to its per-process log directory under clusterPath.
   *
   * Replaces hyphens with underscores in the label and constructs the log path.
   *
   * `anvil` → `<clusterPath>/data/anvil/logs/`
   * `solana-test-validator` → `<clusterPath>/data/solana_validator/logs/`
   * `kiod` → `<clusterPath>/data/kiod/logs/`
   */
  private toProcessLogPath(label: string): string {
    return this.toProcessPath(label, "logs")
  }

  /** Pid file path for a label: `<clusterPath>/data/<processDir>/<label>.pid`. */
  private toProcessPidPath(label: string): string {
    return this.toProcessPath(label, `${label}.pid`)
  }

  /**
   * Ensure cluster and per-process log file streams are open.
   */
  private ensureLogStreams(label: string): void {
    const stamp = currentDateStamp()

    this.clusterLogStream = asOption(this.clusterLogStream).match({
      None: () => {
        const clusterLogPath = mkdirs(ProcessManager.toClusterPath("logs")),
          clusterLogFile = Path.join(clusterLogPath, `cluster_${stamp}.log`)
        log.info(`Cluster log: ${clusterLogFile}`)
        return Fs.createWriteStream(clusterLogFile, {
          flags: "a"
        })
      },
      Some: identity
    })

    // NOW GET THE PROCESS LOG STREAM
    if (!this.processLogStreams.has(label)) {
      const logPath = mkdirs(this.toProcessLogPath(label)),
        logFile = Path.join(logPath, `log_${stamp}.log`)
      this.processLogStreams.set(
        label,
        Fs.createWriteStream(logFile, { flags: "a" })
      )
      log.info(`Process log for ${label}: ${logFile}`)
    }
  }

  /**
   * Write a labeled line to both the cluster log and the per-process log.
   */
  private writeToLogs(label: string, data: string): void {
    const line = data + "\n"
    this.clusterLogStream?.write(line)
    this.processLogStreams.get(label)?.write(line)
  }

  /** Spawn a labeled process and track it. */
  async spawn(config: ProcessConfig): Promise<ProcessHandle> {
    if (this.handles.has(config.label)) {
      throw new Error(`Process "${config.label}" is already running`)
    }

    this.ensureInitialized()
    this.ensureLogStreams(config.label)

    log.info(
      `Spawning ${config.label}: ${config.command} ${config.args.join(" ")}`
    )

    const exitDeferred = new Deferred<number>(),
      pidFile = this.toProcessPidPath(config.label),
      child = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: {
          ...process.env,
          ...(config.env ?? {})
        } as NodeJS.ProcessEnv,
        stdio: ChildStdio,
        detached: false
      })

    const ingestStream = (...streams: NodeJS.ReadableStream[]) => {
      streams.filter(isDefined).forEach(stream => {
        stream.setEncoding("utf8")
        stream.on("data", (chunk: string) => {
          chunk
            .split("\n")
            .filter(Boolean)
            .forEach(line => {
              this.writeToLogs(config.label, line)
            })
        })
      })
    }

    ingestStream(child.stdout, child.stderr)

    child.on("error", err => {
      log.error(`${config.label} spawn error: ${err.message}`)
      if (!exitDeferred.isSettled()) exitDeferred.resolve(1)
    })

    child.on("exit", (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0)
      log.info(`${config.label} exited (code=${code}, signal=${signal})`)
      try {
        Fs.rmSync(pidFile, { force: true })
      } catch {
        /* ignore */
      }
      this.handles.delete(config.label)
      this.children.delete(config.label)
      this.closeProcessLogStream(config.label)
      if (!exitDeferred.isSettled()) exitDeferred.resolve(exitCode)
    })

    const pid = child.pid ?? 0
    if (pid < 1) {
      log.error(`${config.label} exited immediately`)
      exitDeferred.resolveIfUnsettled(0)
      Assert.ok(pid > 0, `Failed to spawn ${config.label}: no pid assigned`)
    }

    mkdirs(Path.dirname(pidFile))
    Fs.writeFileSync(pidFile, String(pid))

    const id = this.nextId++

    const handle: ProcessHandle = {
      id,
      pid,
      pidFile,

      kill: async () => {
        if (exitDeferred.isSettled()) return
        log.info(`Killing ${config.label} (id=${id}, pid=${pid})`)
        try {
          await treeKillAsync(pid, ProcessSignalName.SIGTERM)
        } catch (err: any) {
          log.warn(`SIGTERM failed for ${config.label}: ${err.message}`)
        }

        const timer = new Promise<"timeout">(resolve =>
          setTimeout(() => resolve("timeout"), GracefulKillMs)
        )
        const outcome = await Promise.race([
          exitDeferred.promise.then(() => "exited" as const),
          timer
        ])

        if (outcome === "timeout") {
          log.warn(`${config.label} did not exit in time — SIGKILL`)
          try {
            await treeKillAsync(pid, ProcessSignalName.SIGKILL)
          } catch (err: any) {
            log.warn(`SIGKILL failed for ${config.label}: ${err.message}`)
          }
          await exitDeferred.promise
        }
      },

      wait: () => exitDeferred.promise
    }

    this.handles.set(config.label, handle)
    this.children.set(config.label, child)

    if (config.verifyCallback) {
      const timeoutMs = config.verifyTimeoutMs ?? 60_000,
        intervalMs = config.verifyIntervalMs ?? 15_000,
        deadline = Date.now() + timeoutMs

      let verified = false
      while (Date.now() < deadline) {
        try {
          verified = await config.verifyCallback(handle)
          if (verified) break
        } catch {
          /* not ready yet */
        }
        await new Promise(r => setTimeout(r, intervalMs))
      }
      if (!verified) {
        throw new Error(
          `${config.label} did not pass verification within ${timeoutMs}ms`
        )
      }
      log.info(`${config.label} verified and ready`)
    }

    return handle
  }

  /** Get a running process handle by label. */
  get(label: string): ProcessHandle {
    return this.handles.get(label)
  }

  /** Kill all tracked processes. */
  async killAll(): Promise<void> {
    const labels = [...this.handles.keys()]
    if (labels.length === 0) return
    log.info(`Killing all processes: ${labels.join(", ")}`)
    await Promise.all(
      labels.map(label =>
        this.handles.has(label)
          ? this.handles.get(label).kill()
          : Promise.resolve()
      )
    )
    this.closeAllLogStreams()
  }

  /**
   * Shut down the manager: kill all tracked processes and close log streams.
   * Kept for API compatibility with the previous PM2-backed implementation.
   */
  async disconnect(): Promise<void> {
    await this.killAll()
    this.closeAllLogStreams()
    this.initialized = false
  }

  /** Number of tracked running processes. */
  get count(): number {
    return this.handles.size
  }

  private closeProcessLogStream(label: string): void {
    asOption(this.processLogStreams.get(label)).ifSome(stream => {
      stream.end()
      this.processLogStreams.delete(label)
    })
  }

  private closeAllLogStreams(): void {
    if (this.clusterLogStream) {
      this.clusterLogStream.end()
      this.clusterLogStream = null
    }
    this.processLogStreams.forEach(stream => stream.end())
    this.processLogStreams.clear()
  }
}
