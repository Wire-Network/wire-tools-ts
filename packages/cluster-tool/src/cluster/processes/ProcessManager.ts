import { execFileSync } from "node:child_process"
import Fs from "node:fs"
import Path from "node:path"
import Assert from "node:assert"
import { getValue, guard } from "@wireio/shared"
import { getLogger } from "../../logging/Logger.js"
import { currentDateStamp, mkdirs } from "../../utils/fsUtils.js"
import { processCommandBasename } from "../../utils/processUtils.js"
import type { ManagedProcess } from "./ManagedProcess.js"
import { ProcessSignalName } from "./ProcessSignals.js"

const log = getLogger("ProcessManager")

/** Graceful sweep signal (see ManagedProcess) — appbase flushes on SIGINT. */
const GracefulSignal = ProcessSignalName.SIGINT

/**
 * Process basenames a pidfile may legitimately point at. Sweeps validate a
 * pidfile's pid against this list via `/proc/<pid>/cmdline` before signalling —
 * the recycled-pid guard (a stale pidfile must never kill an unrelated process).
 */
const ManagedProcessNames = [
  "nodeop",
  "kiod",
  "anvil",
  "solana-test-validator"
] as const

/**
 * Every sweep / cleanup in this file is CLUSTER-SCOPED and PID-TARGETED —
 * NEVER a host-wide basename pkill. Incident (2026-07-02): the exit cleanup
 * pkilled `nodeop` by name, host-wide, and armed lazily on the first `push` —
 * so a jest worker whose suite touched the manager SIGINT'd a LIVE flow
 * cluster's nodes when the worker exited. Pids come from the manager's own
 * registry (exit cleanup) or from THIS cluster's pidfiles (orphan sweep).
 */

/** Whether `pid` is live AND running one of the managed basenames. */
function isManagedPid(pid: number): boolean {
  return (ManagedProcessNames as readonly string[]).includes(
    processCommandBasename(pid)
  )
}

/** Signal one pid, tolerating ESRCH (already gone). */
function signalPid(pid: number, signal: ProcessSignalName): void {
  guard(() => process.kill(pid, signal))
}

/**
 * Pids recorded by a prior run on THIS cluster path — every
 * `<cluster>/data/<process>/<label>.pid` whose pid still runs a managed
 * basename (stale files for exited pids are pruned as they're read).
 */
function readOrphanPids(clusterPath: string): number[] {
  const dataPath = Path.join(clusterPath, "data")
  if (!Fs.existsSync(dataPath)) return []
  return Fs.readdirSync(dataPath, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const directory = Path.join(dataPath, entry.name)
      return Fs.readdirSync(directory)
        .filter(name => name.endsWith(".pid"))
        .map(name => Path.join(directory, name))
    })
    .flatMap(pidFile => {
      const pid = getValue(
        () => Number.parseInt(Fs.readFileSync(pidFile, "utf8").trim(), 10),
        Number.NaN
      )
      if (Number.isInteger(pid) && pid > 0 && isManagedPid(pid)) return [pid]
      guard(() => Fs.rmSync(pidFile, { force: true })) // stale — prune
      return []
    })
}

/**
 * Terminate `pids` with the graceful signal, synchronously poll for their exit,
 * then SIGKILL whatever is left. Returns the pids that were force-killed. Only
 * pids passing `isAlive` are touched (default: the recycled-pid guard {@link
 * isManagedPid}, whose zombie semantics — an empty `/proc/<pid>/cmdline` — also
 * make a reaped-but-unwaited child count as exited).
 *
 * `graceMs` is an **idle** window, not a total: every pid that exits RESETS it,
 * and only {@link ProcessManager.SweepHardCapMs} bounds the sweep absolutely. A
 * sweep that is still draining is healthy — cutting it short is precisely what
 * corrupts the cluster — while a genuinely wedged process still hits the cap.
 *
 * A total budget cannot be sized here: nodeop's post-SIGINT work is its
 * chainbase flush + `fork_db.dat` write AND whatever block backlog it is still
 * applying, and on a 24-node local cluster the operator nodes run minutes
 * behind head (`wire latency: 125708 ms` observed at 21 batch operators), so
 * the drain is unbounded in a way no per-process constant covers. Cutting it
 * short leaves `database dirty flag set` (a node that refuses to boot), a
 * missing `fork_db.dat` (lost reversible blocks → stalled finality), and a
 * truncated `blocks.log` whose next hard replay silently discards every block
 * after the truncation point.
 *
 * Synchronous throughout (blocking `sleep` between polls) so process `exit` /
 * signal handlers — where queued async work never resumes — get the SAME
 * guarantee as the async stop path.
 */
export function terminatePidsSync(
  pids: number[],
  graceMs: number,
  isAlive: (pid: number) => boolean = isManagedPid
): number[] {
  let remaining = pids.filter(isAlive)
  if (remaining.length === 0) return []
  remaining.forEach(pid => signalPid(pid, GracefulSignal))
  const hardDeadline = Date.now() + ProcessManager.SweepHardCapMs
  let idleDeadline = Date.now() + graceMs
  remaining = remaining.filter(isAlive)
  while (
    remaining.length > 0 &&
    Date.now() < idleDeadline &&
    Date.now() < hardDeadline
  ) {
    execFileSync("sleep", [String(ProcessManager.SweepPollIntervalMs / 1000)])
    const before = remaining.length
    remaining = remaining.filter(isAlive)
    if (remaining.length < before) idleDeadline = Date.now() + graceMs
  }
  if (remaining.length > 0) {
    log.warn(`Force-killing straggler pid(s): ${remaining.join(", ")}`)
    remaining.forEach(pid => signalPid(pid, ProcessSignalName.SIGKILL))
  }
  return remaining
}

/**
 * Sweep a crashed prior run's processes on THIS cluster path:
 * SIGINT → poll for exit (up to {@link ProcessManager.SweepGraceMs}) → SIGKILL,
 * targeting only pids from the cluster's own pidfiles (validated against the
 * managed basenames). An orphan is usually a HEALTHY nodeop whose CLI died —
 * mid chainbase flush or still serving — so it gets the full graceful window,
 * not a token pause; the poll returns as soon as everything is gone.
 */
function sweepOrphans(clusterPath: string): void {
  const orphans = readOrphanPids(clusterPath)
  if (orphans.length === 0) return
  log.info(`Sweeping ${orphans.length} orphan pid(s) from ${clusterPath}: ${orphans.join(", ")}`)
  terminatePidsSync(orphans, ProcessManager.sweepGraceMs(orphans.length))
}

/**
 * Registry + lifecycle coordinator for {@link ManagedProcess} instances.
 * Static-singleton: {@link setClusterPath} once at CLI-parse time, then
 * {@link get}. Each `ManagedProcess` self-registers in its constructor via
 * {@link push}; the manager owns the orphan sweep, exit handlers, the raw
 * aggregate / per-process log streams, and `stopAll`.
 */
export class ProcessManager {
  private static clusterPath: string
  private static instance: ProcessManager

  /** Set the cluster root (idempotent for the same value). */
  static setClusterPath(clusterPath: string): typeof ProcessManager {
    Assert.ok(
      !this.clusterPath || this.clusterPath === clusterPath,
      `Cluster path can only be set once (current=${this.clusterPath}, new=${clusterPath})`
    )
    this.clusterPath = clusterPath
    return this
  }

  /** Singleton accessor — {@link setClusterPath} must precede it. */
  static get(): ProcessManager {
    Assert.ok(!!this.clusterPath, "Cluster path must be set before ProcessManager.get()")
    return (this.instance ??= new ProcessManager())
  }

  /** Join children onto the cluster root path. */
  static toClusterPath(...children: string[]): string {
    return Path.join(ProcessManager.clusterPath, ...children)
  }

  private readonly processes = new Map<string, ManagedProcess>()
  private clusterLogStream: Fs.WriteStream | null = null
  private readonly processLogStreams = new Map<string, Fs.WriteStream>()
  private initialized = false

  private constructor() {}

  /** One-time: orphan sweep + exit-handler registration (lazy, on first push). */
  private ensureInitialized(): void {
    if (this.initialized) return
    sweepOrphans(ProcessManager.clusterPath)
    this.initialized = true
    const cleanup = () => {
      log.info("ProcessManager: cleanup on exit")
      // Terminate ONLY this manager's registered pids (validated against the
      // managed basenames) — never a host-wide basename kill. The synchronous
      // wait is the point: exiting the CLI while nodeop is still mid
      // chainbase-flush orphans it half-written, and whatever signals it next
      // (or a SIGKILL sweep) leaves `database dirty flag set` for the next
      // boot. `process.exit()` in the signal handlers below runs AFTER this
      // returns, so the children get their full graceful window.
      const pids = [...this.processes.values()].map(managed => managed.pid)
      terminatePidsSync(pids, ProcessManager.sweepGraceMs(pids.length))
      this.processes.forEach(managed => {
        guard(() => Fs.rmSync(managed.pidFile, { force: true }))
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

  /**
   * Explicitly run the one-time orphan sweep + signal-handler installation
   * (idempotent — a no-op once already initialized). {@link push} triggers
   * the same initialization lazily on the first registered process; callers
   * that need the sweep to run BEFORE any process is pushed (e.g.
   * `ClusterManager.run`, which must refuse a still-live cluster before it
   * starts anything) call this directly instead.
   */
  initialize(): void {
    this.ensureInitialized()
  }

  /** A ManagedProcess registers itself here from its constructor (variadic). */
  push(...processes: ManagedProcess[]): this {
    this.ensureInitialized()
    processes.forEach(managed => {
      Assert.ok(
        !this.processes.has(managed.label),
        `Process "${managed.label}" already registered`
      )
      this.processes.set(managed.label, managed)
    })
    return this
  }

  /** Look up a registered process by label. */
  get(label: string): ManagedProcess {
    return this.processes.get(label) ?? null
  }

  /**
   * Deregister an EXITED process so its label can be reused — the restart
   * primitive (stop → remove → create anew). Refuses while the child is alive.
   *
   * @param label - Label of the exited process to deregister.
   */
  remove(label: string): this {
    const managed = this.processes.get(label)
    Assert.ok(managed != null, `Process "${label}" is not registered`)
    Assert.ok(
      !managed.isRunning,
      `Process "${label}" is still running — stop it before removing`
    )
    this.processes.delete(label)
    return this
  }

  /** Snapshot of all registered processes (copy). */
  getAll(): ManagedProcess[] {
    return [...this.processes.values()]
  }

  /**
   * Stop every registered process. `forceKill=false` → graceful `stop()` on
   * each; `forceKill=true` → `kill()` on each. A pre-aborted
   * {@link AbortController} short-circuits each graceful wait to the kill path.
   *
   * @param forceKill - Whether to force-kill instead of graceful-stop.
   */
  async stopAll(forceKill = false): Promise<void> {
    const all = this.getAll()
    if (all.length === 0) return
    log.info(`Stopping ${all.length} process(es) (forceKill=${forceKill})`)
    const controller = new AbortController()
    if (forceKill) controller.abort()
    await Promise.all(
      all.map(managed =>
        forceKill ? managed.kill() : managed.stop(controller.signal)
      )
    )
    this.processes.clear()
    this.closeAllLogStreams()
  }

  // ── raw log artifact (heartbeat-readable; NOT the structured run log) ──

  /**
   * Append a raw child line to the cluster aggregate + per-process raw logs.
   * Called by {@link ManagedProcess.captureOutput} alongside the structured logger.
   *
   * @param label - Owning process label.
   * @param line - The raw child line.
   */
  writeRaw(label: string, line: string): void {
    this.ensureLogStreams(label)
    const out = line + "\n"
    this.clusterLogStream?.write(out)
    this.processLogStreams.get(label)?.write(out)
  }

  private ensureLogStreams(label: string): void {
    const stamp = currentDateStamp()
    this.clusterLogStream ??= Fs.createWriteStream(
      Path.join(
        mkdirs(ProcessManager.toClusterPath("logs")),
        `cluster_${stamp}.log`
      ),
      { flags: "a" }
    )
    if (!this.processLogStreams.has(label)) {
      const dir = mkdirs(
        ProcessManager.toClusterPath("data", label.replaceAll("-", "_"), "logs")
      )
      this.processLogStreams.set(
        label,
        Fs.createWriteStream(Path.join(dir, `log_${stamp}.log`), { flags: "a" })
      )
    }
  }

  /** Close + drop a single process's raw log stream (on its exit). */
  closeProcessLogStream(label: string): void {
    const stream = this.processLogStreams.get(label)
    if (stream) {
      stream.end()
      this.processLogStreams.delete(label)
    }
  }

  private closeAllLogStreams(): void {
    this.clusterLogStream?.end()
    this.clusterLogStream = null
    this.processLogStreams.forEach(stream => stream.end())
    this.processLogStreams.clear()
  }
}

export namespace ProcessManager {
  /**
   * BASE synchronous wait for a SINGLE swept / exit-cleanup pid to leave
   * gracefully before SIGKILL (ms). Deliberately equals {@link
   * ManagedProcess.GracefulKillMs} — the same chainbase-flush window the async
   * stop path grants — kept as an independent literal because a value import of
   * `ManagedProcess` here would create a module cycle. The old 2s grace
   * SIGKILLed nodeop mid-flush and manufactured the `database dirty flag set`
   * unclean-shutdown state.
   */
  export const SweepGraceMs = 30_000
  /**
   * Extra grace granted per ADDITIONAL process in the same sweep (ms). Every pid
   * is signalled at once and they then flush CONCURRENTLY against one disk, so
   * the wall clock a sweep needs grows with the process count — the single-node
   * {@link SweepGraceMs} window does not cover a full cluster.
   */
  export const SweepGracePerProcessMs = 5_000
  /**
   * Absolute ceiling on ONE sweep, however much progress it is making — the
   * backstop against a genuinely wedged process holding the CLI open forever.
   * Generous because the alternative to waiting is a corrupted cluster, and the
   * sweep only reaches this bound when a pid stops responding entirely.
   */
  export const SweepHardCapMs = 10 * 60 * 1000
  /**
   * IDLE window for terminating `processCount` processes in ONE sweep — the
   * no-progress budget {@link terminatePidsSync} resets on every pid that
   * exits, never a fixed total wait: the sweep returns the moment the last pid
   * is gone.
   *
   * Sizing this off the count is load-bearing, not defensive. A 24-node cluster
   * (21 batch operators + producers + bios + underwriter) blew the flat 30s
   * window at `create` exit: 16 nodeops were SIGKILLed mid-flush, which left
   * each one's `blocks.log` truncated and its chainbase dirty. The next
   * `wire-cluster-tool run` then hard-replays, `repair_log` discards the
   * unreadable tail, and every block after it — INCLUDING the bootstrap's
   * `schbatchgps` + `bootstrap-epoch` — is silently lost, so the resumed cluster
   * can never advance an epoch.
   *
   * @param processCount - Pids being terminated in this sweep.
   * @returns The grace window in ms.
   */
  export function sweepGraceMs(processCount: number): number {
    return (
      SweepGraceMs + SweepGracePerProcessMs * Math.max(0, processCount - 1)
    )
  }
  /** Poll gap while waiting for terminated pids to exit (ms). */
  export const SweepPollIntervalMs = 500
}
