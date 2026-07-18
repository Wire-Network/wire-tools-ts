import {
  collectPidSources,
  pidIsAlive,
  readPid,
  type ProcessLivenessEvent,
  type ProcessLivenessSnapshot
} from "@wireio/debugging-shared"

import type { ClusterAccess } from "../services/ClusterAccess.js"

import type { ServerSideStream } from "./ServerSideStream.js"

/**
 * Server-side process-liveness stream. 5-second tick: collects pid sources
 * from the harness layout, probes liveness via `process.kill(pid, 0)`,
 * emits only the diff against the prior snapshot so idle clusters emit
 * nothing per tick.
 */
export class ProcessLivenessStream implements ServerSideStream<ProcessLivenessEvent> {
  private timer: NodeJS.Timeout | null = null
  private prev = new Map<string, ProcessLivenessSnapshot>()
  private stopped = false

  /**
   * @param clusterAccess Source-of-truth for cluster state used to drive
   *                      `collectPidSources`.
   */
  constructor(private readonly clusterAccess: ClusterAccess) {}

  async start(emit: (payload: ProcessLivenessEvent) => void): Promise<void> {
    await this.tick(emit)
    this.timer = setInterval(
      () => void this.tick(emit),
      ProcessLivenessStream.PollMs
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(
    emit: (payload: ProcessLivenessEvent) => void
  ): Promise<void> {
    if (this.stopped) return
    const state = await this.clusterAccess.getState(),
      sources = collectPidSources(this.clusterAccess.clusterPath, state),
      now = Date.now(),
      next = new Map<string, ProcessLivenessSnapshot>()
    sources.forEach(src => {
      const pid = readPid(src.pidPath),
        alive = pidIsAlive(pid),
        prior = this.prev.get(src.label),
        exitedAt = alive ? null : prior?.alive ? now : (prior?.exitedAt ?? now)
      next.set(src.label, {
        label: src.label,
        pid,
        alive,
        lastCheckedAt: now,
        exitedAt
      })
    })
    const setSnapshots: ProcessLivenessSnapshot[] = []
    next.forEach((snap, label) => {
      const prior = this.prev.get(label)
      if (
        !prior ||
        prior.pid !== snap.pid ||
        prior.alive !== snap.alive ||
        prior.exitedAt !== snap.exitedAt
      ) {
        setSnapshots.push(snap)
      }
    })
    const removedLabels = [...this.prev.keys()].filter(
      label => !next.has(label)
    )
    this.prev = next
    if (setSnapshots.length > 0 || removedLabels.length > 0) {
      emit({ setSnapshots, removedLabels })
    }
  }
}

export namespace ProcessLivenessStream {
  /** Liveness poll cadence, ms. Mirrors the TUI's prior local cadence. */
  export const PollMs = 5_000
}
