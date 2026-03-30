import pm2 from "pm2"
import Path from "path"
import Fs from "fs"
import { execFileSync } from "child_process"
import { log } from "../logger.js"
import { Deferred } from "@wireio/shared"
import { asOption } from "@3fv/prelude-ts"
import * as Assert from "node:assert"
import { mkdirs } from "../util"

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
const MANAGED_PROCESS_NAMES = [
  "nodeop",
  "kiod",
  "anvil",
  "solana-test-validator"
]

function pm2Connect(): Promise<void> {
  return asOption(new Deferred<void>())
    .tap(d =>
      pm2.connect(true, err => {
        return err ? d.reject(err) : d.resolve()
      })
    )
    .map(d => d.promise)
    .get()
}

function pm2Start(opts: pm2.StartOptions): Promise<pm2.Proc> {
  return asOption(new Deferred<pm2.Proc>())
    .tap(d =>
      pm2.start(opts, (err, proc) => {
        return err ? d.reject(err) : d.resolve(proc)
      })
    )
    .map(d => d.promise)
    .get()
}

function pm2Delete(name: string): Promise<void> {
  return asOption(new Deferred<void>())
    .tap(d =>
      pm2.delete(name, err => {
        return err ? d.reject(err) : d.resolve()
      })
    )
    .map(d => d.promise)
    .get()
}

function pm2Describe(name: string): Promise<pm2.ProcessDescription[]> {
  return asOption(new Deferred<pm2.ProcessDescription[]>())
    .tap(d =>
      pm2.describe(name, (err, descs) => {
        return err ? d.reject(err) : d.resolve(descs)
      })
    )
    .map(d => d.promise)
    .get()
}

function pm2List(): Promise<pm2.ProcessDescription[]> {
  return asOption(new Deferred<pm2.ProcessDescription[]>())
    .tap(d =>
      pm2.list((err, list) => {
        return err ? d.reject(err) : d.resolve(list)
      })
    )
    .map(d => d.promise)
    .get()
}

function pm2SendSignal(signal: string, name: string): Promise<void> {
  return asOption(new Deferred<void>())
    .tap(d =>
      pm2.sendSignalToProcessName(signal, name, err => {
        return err ? d.reject(err) : d.resolve()
      })
    )
    .map(d => d.promise)
    .get()
}

function pm2LaunchBus(): Promise<any> {
  return asOption(new Deferred<any>())
    .tap(d =>
      pm2.launchBus((err, bus) => {
        return err ? d.reject(err) : d.resolve(bus)
      })
    )
    .map(d => d.promise)
    .get()
}

function currentDateStamp(): string {
  return asOption(new Date())
    .map(
      d =>
        `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
    )
    .get()
}

/** Check if a process with the given name is running via pgrep. */
function isProcessRunning(name: string): boolean {
  try {
    execFileSync("pgrep", ["-x", name], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** Send a signal to all processes matching name via pkill. */
function pkill(name: string, signal?: string): void {
  try {
    const args = signal ? [signal, "-x", name] : ["-x", name]
    execFileSync("pkill", args, { stdio: "ignore" })
  } catch {
    // process not found or already dead
  }
}

/**
 * Kill any existing instances of managed processes (nodeop, kiod, anvil, etc.).
 * Sends SIGTERM first, waits 2s, then SIGKILL for any stragglers.
 */
function killExistingProcesses(): void {
  const running = MANAGED_PROCESS_NAMES.filter(isProcessRunning)
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
      pkill(name, "-9")
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

    await pm2Connect()
    this.connected = true
    this.bus = await pm2LaunchBus()

    this.registerExitHandler()
  }

  /** Register process exit handlers to clean up managed processes. */
  private registerExitHandler(): void {
    if (this.exitHandlerRegistered) return
    this.exitHandlerRegistered = true

    const cleanup = () => {
      log.info("ProcessManager: cleaning up on exit...")
      // Synchronous kill — we're in an exit handler
      for (const name of MANAGED_PROCESS_NAMES) {
        pkill(name)
      }
      this.closeAllLogStreams()
      if (this.connected) {
        pm2.disconnect()
        this.connected = false
      }
    }

    process.on("exit", cleanup)
    process.on("SIGINT", () => {
      cleanup()
      process.exit(130)
    })
    process.on("SIGTERM", () => {
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

  private writeToLogs(label: string, stream: string, data: string): void {
    const ts = new Date().toISOString()
    const line = `${ts} [${label}:${stream}] ${data}\n`
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
    const MAX_STDERR_LINES = 100

    log.info(
      `Spawning ${config.label}: ${config.command} ${config.args.join(" ")}`
    )

    const startOpts: pm2.StartOptions = {
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
    }

    await pm2Start(startOpts)

    // Retrieve process description to get pm_id and pid
    const descs = await pm2Describe(config.label)
    if (!descs || descs.length === 0) {
      throw new Error(
        `Failed to spawn ${config.label}: no process description returned`
      )
    }

    const desc = descs[0],
      pmId = desc.pm_id ?? -1,
      pid = desc.pid ?? 0

    if (pid === 0) {
      throw new Error(`Failed to spawn ${config.label}: no pid assigned`)
    }

    // Listen for log events on the bus
    this.bus.on("log:err", (packet: any) => {
      if (packet.process?.name !== config.label) return
      const lines = String(packet.data).split("\n").filter(Boolean)
      for (const line of lines) {
        log.debug(`[${config.label}:stderr] ${line}`)
        recentStderr.push(line)
        if (recentStderr.length > MAX_STDERR_LINES) recentStderr.shift()
        this.writeToLogs(config.label, "stderr", line)
      }
    })

    this.bus.on("log:out", (packet: any) => {
      if (packet.process?.name !== config.label) return
      const lines = String(packet.data).split("\n").filter(Boolean)
      for (const line of lines) {
        log.debug(`[${config.label}:stdout] ${line}`)
        this.writeToLogs(config.label, "stdout", line)
      }
    })

    // Track exit via bus event
    const exitDeferred = new Deferred<number>()
    const onExit = (packet: any) => {
      if (packet.process?.name !== config.label) return
      const code = packet.process?.exit_code ?? 1
      const signal = packet.process?.signal
      log.info(`${config.label} exited (code=${code}, signal=${signal})`)
      if (code !== 0 && recentStderr.length > 0) {
        log.error(`${config.label} stderr (last ${recentStderr.length} lines):`)
        for (const line of recentStderr) {
          log.error(`  ${line}`)
        }
      }
      this.handles.delete(config.label)
      this.closeProcessLogStream(config.label)
      this.bus.off?.("process:exit", onExit)
      exitDeferred.resolve(code)
    }
    this.bus.on("process:exit", onExit)

    const handle: ProcessHandle = {
      pmId,
      pid,
      recentStderr,

      kill: async () => {
        log.info(`Killing ${config.label} (pm_id=${pmId}, pid=${pid})`)
        try {
          await pm2Delete(config.label)
        } catch (err: any) {
          log.warn(`pm2 delete failed for ${config.label}: ${err.message}`)
        }
        this.handles.delete(config.label)
        this.closeProcessLogStream(config.label)
      },

      wait: () => exitDeferred.promise
    }

    this.handles.set(config.label, handle)
    return handle
  }

  /** Get a running process by label. */
  get(label: string): ProcessHandle | undefined {
    return this.handles.get(label)
  }

  /** Kill all tracked processes. */
  async killAll(): Promise<void> {
    const labels = [...this.handles.keys()]
    log.info(`Killing all processes: ${labels.join(", ")}`)
    await Promise.all(labels.map(label => this.handles.get(label)?.kill()))
  }

  /** Disconnect from the pm2 daemon. Call when done. */
  async disconnect(): Promise<void> {
    if (this.connected) {
      pm2.disconnect()
      this.connected = false
      this.bus = null
    }
    this.closeAllLogStreams()
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
