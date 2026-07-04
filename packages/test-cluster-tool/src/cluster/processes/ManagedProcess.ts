import { spawn, type ChildProcess, type StdioOptions } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"
import Assert from "node:assert"
import treeKill from "tree-kill"
import { Deferred } from "@wireio/shared"
import { getLogger, type Logger } from "../../logging/Logger.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { scaleTimeoutMs, sleep } from "../../utils/asyncUtils.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { ProcessManager } from "./ProcessManager.js"
import { ProcessSignalName } from "./ProcessSignals.js"

/** Graceful stop signal — appbase (nodeop/kiod) flushes chainbase on SIGINT;
 *  anvil + solana-test-validator also Ctrl-C cleanly on SIGINT. SIGTERM skips
 *  the nodeop flush and silently loses recently-irreversible writes. */
const GracefulSignalName = ProcessSignalName.SIGINT

/** child stdio: ignore stdin, pipe stdout/stderr (typed literals, not magic). */
const ChildStdio: StdioOptions = ["ignore", "pipe", "pipe"]

/**
 * Abstract base for a harness-managed OS process. Subclasses supply {@link exe}/
 * {@link args} (and optionally override {@link cwd}/{@link env}/{@link verifyReady})
 * and pass their identity (label + kind) to `super(...)`; the base owns spawn,
 * stream capture, the pid file, the verify-ready loop, graceful stop, force
 * kill, and wait.
 *
 * Construction-safe: the constructor reads the {@link ManagedProcess.Identity}
 * object and NOTHING else — it NEVER calls an overridden getter (`exe`/`args`/
 * `cwd`/`env`) during base construction (which would run before the subclass
 * assigned its config). Inverted ownership: it self-registers via
 * `manager.push(this)`.
 */
export abstract class ManagedProcess {
  readonly label: string
  readonly processKind: ManagedProcess.Kind
  protected readonly log: Logger

  protected constructor(
    readonly manager: ProcessManager,
    identity: ManagedProcess.Identity
  ) {
    this.label = identity.label
    this.processKind = identity.kind
    this.log = getLogger(`cluster.${identity.label}`)
    manager.push(this)
  }

  // ── subclass surface (read at start(), NEVER during base construction) ──

  /** Absolute path of the executable. */
  abstract get exe(): string
  /** Command-line arguments (without the exe). */
  abstract get args(): string[]
  /** Working directory — defaults to the exe's directory. */
  get cwd(): string {
    return Path.dirname(this.exe)
  }
  /** Extra env merged over `process.env` — defaults to none. */
  get env(): Record<string, string> {
    return {}
  }

  /** Health gate polled after spawn; default = up immediately. */
  protected verifyReady(): Promise<boolean> {
    return Promise.resolve(true)
  }
  protected get verifyTimeoutMs(): number {
    return ManagedProcess.DefaultVerifyTimeoutMs
  }
  protected get verifyIntervalMs(): number {
    return ManagedProcess.DefaultVerifyIntervalMs
  }

  // ── handle surface (folds the old ProcessHandle) ──

  private static nextId = 0
  private idInternal = -1
  private pidInternal = 0
  private child: ChildProcess | null = null
  private readonly exited = new Deferred<number>()

  get id(): number {
    return this.idInternal
  }
  get pid(): number {
    return this.pidInternal
  }
  /** True while the child is alive — spawned and not yet exited. */
  get isRunning(): boolean {
    return this.child != null && !this.exited.isSettled()
  }
  /** Pid file path: `<clusterPath>/data/<label>/<label>.pid`. */
  get pidFile(): string {
    return ProcessManager.toClusterPath(
      "data",
      this.label.replaceAll("-", "_"),
      `${this.label}.pid`
    )
  }

  /** Spawn, capture output, write the pid file, await {@link verifyReady}. Fluent. */
  async start(): Promise<this> {
    Assert.ok(!this.child, `${this.label} already started`)
    this.log.info(`spawning ${this.exe} ${this.args.join(" ")}`)
    // The step that starts a process gets the FULL spawn in its extra — the
    // executable + argv is the step's payload, same as a clio command line.
    StepExtraRecorder.record({
      client: "process",
      kind: "spawn",
      label: this.label,
      command: [this.exe, ...this.args],
      cwd: this.cwd
    })
    const child = spawn(this.exe, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env } as NodeJS.ProcessEnv,
      stdio: ChildStdio,
      detached: false
    })
    this.child = child
    this.idInternal = ManagedProcess.nextId++
    this.captureOutput(child.stdout)
    this.captureOutput(child.stderr, true)

    child.on("error", error => {
      this.log.error(`${this.label} spawn error: ${error.message}`, error)
      if (!this.exited.isSettled()) this.exited.resolve(1)
    })
    child.on("exit", (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0)
      this.log.info(`${this.label} exited (code=${code}, signal=${signal})`)
      Fs.rmSync(this.pidFile, { force: true })
      this.manager.closeProcessLogStream(this.label)
      if (!this.exited.isSettled()) this.exited.resolve(exitCode)
    })

    this.pidInternal = child.pid ?? 0
    Assert.ok(this.pidInternal > 0, `${this.label} failed to spawn (no pid)`)
    mkdirs(Path.dirname(this.pidFile))
    Fs.writeFileSync(this.pidFile, String(this.pidInternal))

    await this.awaitReady()
    return this
  }

  private async awaitReady(): Promise<void> {
    // Verify-ready windows are calibrated wall-clock constants — scale them
    // with the flow timing scale (a starved shared host boots daemons slower).
    const verifyBudgetMs = scaleTimeoutMs(this.verifyTimeoutMs)
    const deadline = Date.now() + verifyBudgetMs
    while (Date.now() < deadline) {
      try {
        if (await this.verifyReady()) {
          this.log.info(`${this.label} ready`)
          return
        }
      } catch (error) {
        // expected pre-ready transients (ECONNREFUSED, 404) — breadcrumb, keep polling
        this.log.debug(
          `${this.label} not ready yet: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      await sleep(this.verifyIntervalMs)
    }
    throw new Error(
      `${this.label} did not pass verifyReady within ${verifyBudgetMs}ms`
    )
  }

  /**
   * Forward each captured child line to the raw aggregate log (heartbeat
   * artifact, via {@link ProcessManager.writeRaw}) AND the structured logger.
   * stderr → warn, stdout → info.
   */
  protected captureOutput(
    stream: NodeJS.ReadableStream | null,
    isErr = false
  ): void {
    if (!stream) return
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) =>
      chunk
        .split("\n")
        .filter(Boolean)
        .forEach(line => {
          this.manager.writeRaw(this.label, line)
          if (isErr) this.log.warn(line)
          else this.log.info(line)
        })
    )
  }

  /**
   * Graceful stop (SIGINT + chainbase flush). A `signal` (from
   * {@link ProcessManager.stopAll}) lets a later forced kill cancel the
   * in-flight wait → escalate to SIGKILL.
   *
   * @param signal - Optional abort signal that short-circuits the graceful wait.
   */
  async stop(signal?: AbortSignal): Promise<void> {
    if (!this.child || this.exited.isSettled()) return
    this.log.info(`stopping ${this.label} (pid=${this.pidInternal})`)
    await this.signalTree(GracefulSignalName)
    const aborted = new Promise<"abort">(resolve =>
      signal?.addEventListener("abort", () => resolve("abort"), { once: true })
    )
    const timer = new Promise<"timeout">(resolve =>
      setTimeout(() => resolve("timeout"), ManagedProcess.GracefulKillMs)
    )
    const outcome = await Promise.race([
      this.exited.promise.then(() => "exited" as const),
      timer,
      aborted
    ])
    if (outcome !== "exited") {
      this.log.warn(`${this.label} did not exit gracefully (${outcome}) — SIGKILL`)
      await this.kill()
    }
  }

  /** Force kill (SIGKILL), then await exit. */
  async kill(): Promise<void> {
    if (!this.child || this.exited.isSettled()) return
    await this.signalTree(ProcessSignalName.SIGKILL)
    await this.exited.promise
  }

  /** Resolve with the exit code once exited. */
  wait(): Promise<number> {
    return this.exited.promise
  }

  private signalTree(signal: ProcessSignalName): Promise<void> {
    return Deferred.useCallback<void>(deferred =>
      treeKill(this.pidInternal, signal, error =>
        error ? deferred.reject(error) : deferred.resolve()
      )
    ).promise.catch(error =>
      this.log.warn(
        `${signal} failed for ${this.label}: ${error instanceof Error ? error.message : String(error)}`
      )
    )
  }
}

export namespace ManagedProcess {
  /** What kind of process this is (its OS basename) — set once at construction. */
  export enum Kind {
    nodeop = "nodeop",
    kiod = "kiod",
    anvil = "anvil",
    solanaValidator = "solana-test-validator"
  }

  /** Construction-safe identity passed to `super(...)` — the base reads THIS,
   *  not any overridden getter. */
  export interface Identity {
    label: string
    kind: Kind
  }

  /** Window for a graceful SIGINT exit before escalating to SIGKILL (ms) — must
   *  exceed nodeop's chainbase flush. */
  export const GracefulKillMs = 30_000
  export const DefaultVerifyTimeoutMs = 180_000
  export const DefaultVerifyIntervalMs = 1_000
}
