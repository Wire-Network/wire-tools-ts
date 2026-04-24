import Fs from "node:fs"
import { asOption } from "@3fv/prelude-ts"
import { match } from "ts-pattern"
import { LoggingManager } from "../../logging/LoggingManager.js"
import { ReduxService } from "../../services/ReduxService.js"
import { ServiceId } from "../../services/ServiceId.js"
import type { Service } from "../../services/Service.js"
import type { ServiceManager } from "../../services/ServiceManager.js"
import { selectCluster } from "../../store/cluster/ClusterSelectors.js"
import {
  removeProcess,
  setProcess
} from "../../store/processMonitor/ProcessMonitorSlice.js"
import type { ProcessLiveness } from "../../store/processMonitor/ProcessMonitorTypes.js"
import {
  collectPidSources,
  type PidSource
} from "./util/PidSources.js"

/**
 * Probes kernel liveness for every pid-file-backed cluster process every 5s.
 * Covers nodeop nodes (producer/bios/batch-operator/underwriter), Anvil, and
 * the Solana test validator.
 */
export class ProcessMonitorService implements Service {
  static readonly id = ServiceId.ProcessMonitor
  static readonly dependsOn: readonly string[] = [ServiceId.Redux]

  private readonly log = LoggingManager.getLogger(
    ProcessMonitorService.Category
  )
  private timer: NodeJS.Timeout | null = null
  private redux: ReduxService | null = null

  async init(manager: ServiceManager): Promise<this> {
    this.redux = manager.get<ReduxService>(ServiceId.Redux)
    return this
  }

  async start(_manager: ServiceManager): Promise<this> {
    if (!this.redux) return this
    this.poll()
    this.timer = setInterval(
      () => this.poll(),
      ProcessMonitorService.PollIntervalMs
    )
    return this
  }

  async stop(_manager: ServiceManager): Promise<this> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this
  }

  /**
   * Enumerate every pid-backed source, snapshot liveness, update Redux.
   * Stale labels that no longer correspond to a pid file are pruned.
   */
  private poll(): void {
    if (!this.redux) return
    const cluster = selectCluster(this.redux.getState())
    if (!cluster.state || !cluster.path) return
    const now = Date.now(),
      sources = collectPidSources(cluster.path, cluster.state),
      seenLabels = new Set<string>()
    sources.forEach(source => {
      const pid = readPid(source.pidPath),
        alive = pidIsAlive(pid),
        prev = this.redux!.getState().processMonitor.processes[source.label],
        exitedAt = match({ alive, prev })
          .with({ alive: true }, () => null)
          .with({ alive: false, prev: { alive: true } }, () => now)
          .otherwise(({ prev: p }) => p?.exitedAt ?? null) as number | null
      seenLabels.add(source.label)
      const liveness: ProcessLiveness = {
        label: source.label,
        pid,
        alive,
        lastCheckedAt: now,
        exitedAt
      }
      this.redux!.dispatch(setProcess(liveness))
    })
    const existing = Object.keys(this.redux.getState().processMonitor.processes)
    existing
      .filter(label => !seenLabels.has(label))
      .forEach(label => this.redux!.dispatch(removeProcess(label)))
  }

  /** Snapshot of the latest pid-source list for panels / sibling services. */
  listSources(): PidSource[] {
    if (!this.redux) return []
    const cluster = selectCluster(this.redux.getState())
    return cluster.path
      ? collectPidSources(cluster.path, cluster.state)
      : []
  }
}

export namespace ProcessMonitorService {
  /** Log category. */
  export const Category = "tui:process-monitor" as const
  /** Interval between liveness snapshots. */
  export const PollIntervalMs = 5_000
}

/** Read pid from a pid file; null on missing / malformed / non-positive. */
function readPid(pidPath: string): number | null {
  return asOption(pidPath)
    .filter(p => Fs.existsSync(p))
    .map(p => Fs.readFileSync(p, "utf8").trim())
    .map(s => parseInt(s, 10))
    .filter(n => !isNaN(n) && n > 0)
    .getOrNull()
}

/** Null-safe `process.kill(pid, 0)` liveness probe. */
function pidIsAlive(pid: number | null): boolean {
  return asOption(pid)
    .map(p => {
      try {
        process.kill(p, 0)
        return true
      } catch {
        return false
      }
    })
    .getOrElse(false)
}
