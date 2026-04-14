import PM2Service from "pm2"
import Path from "path"
import Fs from "fs"
import { execFileSync } from "child_process"
import { log } from "../logger.js"
import { Deferred, isObject } from "@wireio/shared"
import { asOption } from "@3fv/prelude-ts"
import { ProcessSignalName } from "./ProcessSignals.js"
import * as Assert from "node:assert"
import { mkdirs } from "../util.js"

const MAX_STDERR_LINES = 100

export interface ProcessConfig {
  /** Human-readable label for logging */
  label: string
  /** Path to the executable */
  command: string
  /** Command-line arguments */
  args: string[]
  /** Working directory */
  cwd?: string
  /** Environment variables (merged with process.env) */
  env?: Record<string, string>
  /** Path for stdout/stderr log file */
  logFile?: string
  /**
   * Optional verification callback invoked after spawn.
   * Called repeatedly until it returns true or the timeout expires.
   * Use this to wait for a process to reach a ready/synced state.
   */
  verifyCallback?: (handle: ProcessHandle) => Promise<boolean>
  /** Timeout for verifyCallback polling (default: 60_000ms) */
  verifyTimeoutMs?: number
  /** Interval between verifyCallback polls (default: 15_000ms) */
  verifyIntervalMs?: number
}

export interface ProcessHandle {
  /** pm2 process id */
  pmId: number
  /** OS-level PID (if available) */
  pid: number
  /** Kill the process and remove it from pm2 */
  kill(): Promise<void>
  /** Wait for the process to stop */
  wait(): Promise<number>
  /** Collected stderr lines (last N) */
  recentStderr: string[]
}

/** Process names to kill at startup and on exit */
const ManagedProcessNames = [
  "nodeop",
  "kiod",
  "anvil",
  "solana-test-validator"
] as const

type ManagedProcessName = (typeof ManagedProcessNames)[number]

namespace pm2 {
  export function connect(): Promise<void> {
    return Deferred.useCallback<void>(d =>
      PM2Service.connect(true, err => {
        return err ? d.reject(err) : d.resolve()
      })
    ).promise
  }

  export function start(
    opts: PM2Service.StartOptions
  ): Promise<PM2Service.Proc> {
    return Deferred.useCallback<PM2Service.Proc>(d =>
      PM2Service.start(opts, (err, proc) => {
        return err ? d.reject(err) : d.resolve(proc)
      })
    ).promise
  }

  export function destroy(name: string): Promise<void> {
    return Deferred.useCallback<void>(d =>
      PM2Service.delete(name, err => {
        return err ? d.reject(err) : d.resolve()
      })
    ).promise
  }

  export function describe(
    name: string
  ): Promise<PM2Service.ProcessDescription[]> {
    return Deferred.useCallback<PM2Service.ProcessDescription[]>(d =>
      PM2Service.describe(name, (err, descs) => {
        return err ? d.reject(err) : d.resolve(descs)
      })
    ).promise
  }

  export function list(): Promise<PM2Service.ProcessDescription[]> {
    return Deferred.useCallback<PM2Service.ProcessDescription[]>(d =>
      PM2Service.list((err, list) => {
        return err ? d.reject(err) : d.resolve(list)
      })
    ).promise
  }

  export function sendSignal(
    signal: ProcessSignalName,
    name: string
  ): Promise<void> {
    return Deferred.useCallback<void>(d =>
      PM2Service.sendSignalToProcessName(signal, name, err => {
        err ? d.reject(err) : d.resolve()
      })
    ).promise
  }

  export function launchBus(): Promise<any> {
    return Deferred.useCallback(d =>
      PM2Service.launchBus((err, bus) => {
        return err ? d.reject(err) : d.resolve(bus)
      })
    ).promise
  }
}

function currentDateStamp(date: Date = new Date()): string {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
}

/** Check if a process with the given name is running via pgrep. */
function isProcessRunning(name: ManagedProcessName): boolean {
  try {
    execFileSync("pgrep", ["-x", name], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** Send a signal to all processes matching name via pkill. */
function pkill(
  name: ManagedProcessName,
  signal: ProcessSignalName = ProcessSignalName.SIGTERM
): boolean {
  try {
    const args = [`-${signal}`, "-x", name]
    execFileSync("pkill", args, { stdio: "ignore" })
    return true
  } catch {
    log.debug(`Failed to kill process ${name} with signal ${signal}`)
    return false
  }
}

/**
 * Kill any existing instances of managed processes (nodeop, kiod, anvil, etc.).
 * Sends SIGTERM first, waits 2s, then SIGKILL for any stragglers.
 */
function killExistingProcesses(): void {
  const running = ManagedProcessNames.filter(isProcessRunning)
  if (running.length === 0) return

  log.info(`Killing existing processes: ${running.join(", ")}`)
  for (const name of running) {
    pkill(name)
  }

  // Wait 2s for graceful shutdown
  execFileSync("sleep", ["2"])

  // SIGKILL any stragglers
  const stragglers = running.filter(isProcessRunning)
  if (stragglers.length > 0) {
    log.warn(`Force-killing stragglers: ${stragglers.join(", ")}`)
    for (const name of stragglers) {
      pkill(name, ProcessSignalName.SIGKILL)
    }
  }
}

/**
 * Generic process manager backed by pm2's programmatic API.
 *
 * On first connection, kills any existing nodeop/kiod/anvil/solana-test-validator
 * processes at the OS level (pkill). Registers exit handlers so that all managed
 * processes are stopped gracefully when the tool exits.
 */
export class ProcessManager {
  private static clusterPath: string

  private static instance: ProcessManager

  static setClusterPath(clusterPath: string): typeof ProcessManager {
    Assert.ok(
      !this.clusterPath || this.clusterPath === clusterPath,
      `Cluster Path can only be set once (currentValue=${this.clusterPath},newValue=${clusterPath}`
    )
    this.clusterPath = clusterPath
    return this
  }

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

  private handles: Map<string, ProcessHandle> = new Map()
  private connected = false
  private bus: any = null

  private clusterLogStream: Fs.WriteStream | null = null
  private processLogStreams: Map<string, Fs.WriteStream> = new Map()
  private exitHandlerRegistered = false

  private constructor() {}

  static toClusterPath(...children: string[]): string {
    return Path.join(ProcessManager.clusterPath, ...children)
  }

  /** Ensure we have a pm2 daemon connection. */
  private async ensureConnected(): Promise<void> {
    if (this.connected) return

    // Kill any leftover processes from a previous run before connecting
    killExistingProcesses()

    await pm2.connect()
    this.connected = true
    this.bus = await pm2.launchBus()

    this.registerExitHandler()
  }

  /** Register process exit handlers to clean up managed processes. */
  private registerExitHandler(): void {
    if (this.exitHandlerRegistered) return
    this.exitHandlerRegistered = true

    const cleanup = () => {
      log.info("ProcessManager: cleaning up on exit...")
      // Synchronous kill — we're in an exit handler
      for (const name of ManagedProcessNames) {
        pkill(name)
      }
      this.closeAllLogStreams()
      if (this.connected) {
        PM2Service.disconnect()
        this.connected = false
      }
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

  /**
   * Map a process label to its per-process log directory under clusterPath.
   *
   * Labels like `node-bios`, `node-00`, `node-batchop_00` map to
   * `<clusterPath>/data/node_bios/logs/`, `<clusterPath>/data/node_00/logs/`, etc.
   *
   * `anvil` → `<clusterPath>/data/anvil/logs/`
   * `solana-test-validator` → `<clusterPath>/data/solana_validator/logs/`
   * `kiod` → `<clusterPath>/data/kiod/logs/`
   */
  private toProcessLogPath(label: string): string {
    let logPath: string
    if (label.startsWith("node-")) {
      // node-bios → node_bios, node-00 → node_00, node-batchop_00 → node_batchop_00
      logPath = label.replace("node-", "node_")
    } else if (label === "solana-test-validator") {
      logPath = "solana_validator"
    } else {
      logPath = label
    }
    return ProcessManager.toClusterPath("data", logPath, "logs")
  }

  private ensureLogStreams(label: string): void {
    const stamp = currentDateStamp()

    // Combined cluster log
    if (!this.clusterLogStream) {
      const clusterLogPath = mkdirs(ProcessManager.toClusterPath("logs")),
        clusterLogFile = Path.join(clusterLogPath, `cluster_${stamp}.log`)
      this.clusterLogStream = Fs.createWriteStream(clusterLogFile, {
        flags: "a"
      })
      log.info(`Cluster log: ${clusterLogFile}`)
    }

    // Per-process log
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

  private writeToLogs(label: string, data: string): void {
    const ts = new Date().toISOString()
    const line = `${ts} [${label}] ${data}\n`
    this.clusterLogStream?.write(line)
    this.processLogStreams.get(label)?.write(line)
  }

  /** Spawn a labeled process via pm2 and track it. */
  async spawn(config: ProcessConfig): Promise<ProcessHandle> {
    if (this.handles.has(config.label)) {
      throw new Error(`Process "${config.label}" is already running`)
    }

    await this.ensureConnected()
    this.ensureLogStreams(config.label)

    const recentStderr: string[] = []

    log.info(
      `Spawning ${config.label}: ${config.command} ${config.args.join(" ")}`
    )

    // Register bus listeners BEFORE start so early exits are captured
    const exitDeferred = new Deferred<number>(),
      onLogHandler = (packet: any) => {
        if (packet.process?.name !== config.label) return
        String(packet.data)
          .split("\n")
          .filter(Boolean)
          .forEach(line => {
            //log.debug(`[${config.label}] ${line}`)
            this.writeToLogs(config.label, line)
          })
      }

    this.bus.on("log:err", onLogHandler)

    this.bus.on("log:out", onLogHandler)

    // Track exit via bus event
    const onExit = (packet: any) => {
      asOption(packet.process)
        .filter(isObject)
        .filter(({ name }: any) => name === config.label)
        .ifSome(({ exit_code: code = 1, signal }: any) => {
          log.info(`${config.label} exited (code=${code}, signal=${signal})`)
          if (code !== 0 && recentStderr.length > 0) {
            log.error(
              `${config.label} stderr (last ${recentStderr.length} lines):`
            )
            recentStderr.forEach(line => {
              log.error(`  ${line}`)
            })
          }
          this.handles.delete(config.label)
          this.closeProcessLogStream(config.label)
          this.bus.off?.("process:exit", onExit)
          exitDeferred.resolve(code)
        })
    }

    this.bus.on("process:exit", onExit)

    // Start the process (bus listeners are already attached to capture early output)
    await pm2.start({
      name: config.label,
      script: config.command,
      args: config.args,
      cwd: config.cwd,
      interpreter: "none",
      autorestart: false,
      env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
      ...(config.logFile
        ? { output: config.logFile, error: config.logFile }
        : {})
    } satisfies PM2Service.StartOptions)

    // Retrieve process description to get pm_id and pid
    const descs = await pm2.describe(config.label)
    Assert.ok(
      descs?.length > 0,
      `Failed to spawn ${config.label}: no process description returned`
    )

    const desc = descs[0],
      pmId = desc.pm_id ?? -1,
      pid = desc.pid ?? 0

    if (pid <= 0 && recentStderr.length > 0) {
      log.error(`${config.label} exited immediately, stderr:`)
      recentStderr.forEach(line => log.error(`  ${line}`))
    }
    Assert.ok(pid > 0, `Failed to spawn ${config.label}: no pid assigned`)

    const handle: ProcessHandle = {
      pmId,
      pid,
      recentStderr,

      kill: async () => {
        log.info(`Killing ${config.label} (pm_id=${pmId}, pid=${pid})`)
        try {
          await pm2.destroy(config.label)
        } catch (err: any) {
          log.warn(`pm2 delete failed for ${config.label}: ${err.message}`)
        }
        this.handles.delete(config.label)
        this.closeProcessLogStream(config.label)
      },

      wait: () => exitDeferred.promise
    }

    this.handles.set(config.label, handle)

    // Run verify callback if provided — poll until ready or timeout
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
          // not ready yet
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

  /** Get a running process by label. */
  get(label: string): ProcessHandle {
    return this.handles.get(label)
  }

  /** Kill all tracked processes. */
  async killAll(): Promise<void> {
    const labels = [...this.handles.keys()]
    log.info(`Killing all processes: ${labels.join(", ")}`)
    await Promise.all(labels.map(label => this.handles.get(label)?.kill()))
    this.closeAllLogStreams()
  }

  /** Disconnect from the pm2 daemon. Call when done. */
  async disconnect(): Promise<void> {
    if (this.connected) {
      PM2Service.disconnect()
      this.connected = false
      this.bus = null
    }

    this.closeAllLogStreams()

    await Deferred.useCallback(d =>
      PM2Service.killDaemon(err => {
        if (err) {
          d.reject(err)
        } else {
          d.resolve()
        }
      })
    ).promise
  }

  /** Number of tracked running processes. */
  get count(): number {
    return this.handles.size
  }

  private closeProcessLogStream(label: string): void {
    const stream = this.processLogStreams.get(label)
    if (stream) {
      stream.end()
      this.processLogStreams.delete(label)
    }
  }

  private closeAllLogStreams(): void {
    if (this.clusterLogStream) {
      this.clusterLogStream.end()
      this.clusterLogStream = null
    }
    for (const [, stream] of this.processLogStreams) {
      stream.end()
    }
    this.processLogStreams.clear()
  }
}
