import { ChildProcess, spawn, SpawnOptions } from "child_process"
import { log } from "../logger.js"
import treeKill from "tree-kill"

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
  /** The underlying ChildProcess */
  process: ChildProcess
  /** PID */
  pid: number
  /** Kill the process tree */
  kill(): Promise<void>
  /** Wait for process to exit */
  wait(): Promise<number>
  /** Collected stderr lines (last N) */
  recentStderr: string[]
}

/**
 * Generic child process manager with PID tracking, signal handling,
 * and tree-kill support. Inspired by cluster_manager.py's approach.
 */
export class ProcessManager {
  private handles: Map<string, ProcessHandle> = new Map()

  /** Spawn a labeled child process and track it. */
  async spawn(config: ProcessConfig): Promise<ProcessHandle> {
    if (this.handles.has(config.label)) {
      throw new Error(`Process "${config.label}" is already running`)
    }

    const spawnOpts: SpawnOptions = {
      cwd: config.cwd,
      env: { ...process.env, ...(config.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    }

    log.info(`Spawning ${config.label}: ${config.command} ${config.args.join(" ")}`)
    const child = spawn(config.command, config.args, spawnOpts)

    if (!child.pid) {
      throw new Error(`Failed to spawn ${config.label}`)
    }

    const recentStderr: string[] = []
    const MAX_STDERR_LINES = 100

    child.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean)
      for (const line of lines) {
        log.debug(`[${config.label}:stdout] ${line}`)
      }
    })

    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n").filter(Boolean)
      for (const line of lines) {
        log.debug(`[${config.label}:stderr] ${line}`)
        recentStderr.push(line)
        if (recentStderr.length > MAX_STDERR_LINES) recentStderr.shift()
      }
    })

    const handle: ProcessHandle = {
      process: child,
      pid: child.pid,
      recentStderr,

      kill: () =>
        new Promise<void>((resolve, reject) => {
          if (!child.pid) return resolve()
          log.info(`Killing ${config.label} (pid ${child.pid})`)
          treeKill(child.pid, "SIGTERM", err => {
            if (err) {
              log.warn(`tree-kill failed for ${config.label}, trying SIGKILL: ${err.message}`)
              treeKill(child.pid!, "SIGKILL", () => resolve())
            } else {
              resolve()
            }
          })
        }),

      wait: () =>
        new Promise<number>(resolve => {
          child.on("exit", (code) => resolve(code ?? 1))
        }),
    }

    child.on("exit", (code, signal) => {
      log.info(`${config.label} exited (code=${code}, signal=${signal})`)
      if (code !== 0 && code !== null && recentStderr.length > 0) {
        log.error(`${config.label} stderr (last ${recentStderr.length} lines):`)
        for (const line of recentStderr) {
          log.error(`  ${line}`)
        }
      }
      this.handles.delete(config.label)
    })

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

  /** Number of tracked running processes. */
  get count(): number {
    return this.handles.size
  }
}
