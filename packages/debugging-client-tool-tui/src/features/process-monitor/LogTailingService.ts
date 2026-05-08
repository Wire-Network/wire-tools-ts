import { EventEmitter } from "eventemitter3"
import {
  ClosedReason,
  StreamTopic,
  type LogTailEvent
} from "@wireio/debugging-shared"
import type {
  DebuggingClient,
  DebuggingSubscription
} from "@wireio/debugging-client-shared"

import { LoggingManager } from "../../logging/LoggingManager.js"
import { DebuggingClientService } from "../../services/DebuggingClientService.js"
import { ReduxService } from "../../services/ReduxService.js"
import { ServiceId } from "../../services/ServiceId.js"
import type { Service } from "../../services/Service.js"
import type { ServiceManager } from "../../services/ServiceManager.js"
import { selectLogViewer } from "../../store/process-monitor/ProcessMonitorSelectors.js"

/**
 * Runtime counters surfaced by the log viewer. Kept off Redux so a 200 ms
 * tick doesn't re-render every store subscriber across the app.
 */
export interface LogTailingRuntime {
  totalLines: number
  totalBytes: number
  indexing: boolean
}

/**
 * Typed event map for {@link LogTailingService}'s `EventEmitter3` base.
 */
export interface LogTailingEvents {
  /** Counters or indexing flag changed. */
  update: (runtime: LogTailingRuntime) => void
  /** A new path was selected — pre-load / pre-clear hook for the panel. */
  pathChanged: (next: string | null) => void
}

/**
 * Tails the path currently selected in the log viewer Redux slice via
 * the {@link DebuggingClient}'s {@link StreamTopic.LogTail} subscription.
 *
 * Maintains a small in-memory line buffer so the viewer can render
 * windows without a network round-trip per scroll. Counters are
 * surfaced via `EventEmitter3` events so the panel re-renders only when
 * it cares (e.g. while following / on indexing-flag transitions).
 */
export class LogTailingService
  extends EventEmitter<LogTailingEvents>
  implements Service
{
  static readonly id = ServiceId.LogTailing
  static readonly dependsOn: readonly string[] = [
    ServiceId.Redux,
    ServiceId.DebuggingClient,
    ServiceId.ProcessMonitor
  ]

  private readonly log = LoggingManager.getLogger(LogTailingService.Category)
  private redux: ReduxService | null = null
  private client: DebuggingClient | null = null
  private subscription: DebuggingSubscription<LogTailEvent> | null = null
  private currentPath: string | null = null
  private lines: string[] = []
  private runtime: LogTailingRuntime = {
    totalLines: 0,
    totalBytes: 0,
    indexing: false
  }
  private unsubscribe: (() => void) | null = null

  async init(manager: ServiceManager): Promise<this> {
    this.redux = manager.get<ReduxService>(ServiceId.Redux)
    this.client = manager.get<DebuggingClientService>(
      ServiceId.DebuggingClient
    ).client
    return this
  }

  async start(_manager: ServiceManager): Promise<this> {
    if (!this.redux) return this
    this.unsubscribe = this.redux.subscribe(() => void this.onStoreChange())
    return this
  }

  async stop(_manager: ServiceManager): Promise<this> {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.subscription?.close(ClosedReason.ClientRequested)
    this.subscription = null
    this.removeAllListeners()
    return this
  }

  /** Visible-window read for panel rendering. Clamped to complete-line count. */
  async readWindow(from: number, count: number): Promise<string[]> {
    const max = this.runtime.totalLines
    if (from >= max || count <= 0) return []
    const safeCount = Math.min(count, max - from)
    if (this.lines.length < from + safeCount && this.client && this.currentPath) {
      // Fill cache from the server / disk for the requested window.
      const fetched = await this.client.readLogWindow({
        path: this.currentPath,
        fromLine: from,
        count: safeCount
      })
      // Splice the fetched range into the local buffer.
      while (this.lines.length < from) this.lines.push("")
      fetched.forEach((line, i) => {
        this.lines[from + i] = line
      })
    }
    return this.lines.slice(from, from + safeCount)
  }

  /** Current counters snapshot. */
  getRuntime(): LogTailingRuntime {
    return this.runtime
  }

  private async onStoreChange(): Promise<void> {
    if (!this.redux || !this.client) return
    const viewer = selectLogViewer(this.redux.getState())
    if (viewer.path === this.currentPath) return
    // Path changed — tear down old subscription and start a new one.
    this.subscription?.close(ClosedReason.ClientRequested)
    this.subscription = null
    this.currentPath = viewer.path
    this.lines = []
    this.runtime = {
      totalLines: 0,
      totalBytes: 0,
      indexing: !!viewer.path
    }
    this.emit(LogTailingEventName.PathChanged, this.currentPath)
    this.emit(LogTailingEventName.Update, this.runtime)
    if (!viewer.path) return
    try {
      const stat = await this.client.getLogStat(viewer.path)
      this.runtime = {
        totalLines: stat.totalLines,
        totalBytes: stat.totalBytes,
        indexing: false
      }
      this.emit(LogTailingEventName.Update, this.runtime)
      this.subscription = await this.client.subscribe(StreamTopic.LogTail, {
        path: viewer.path
      })
      this.subscription.on("event", evt => this.onTailEvent(evt))
      this.subscription.on("closed", reason =>
        this.log.warn(`log-tail subscription closed: ${reason}`)
      )
    } catch (err) {
      this.log.error(`Failed to start log tail for ${viewer.path}`, err)
      this.runtime = { ...this.runtime, indexing: false }
      this.emit(LogTailingEventName.Update, this.runtime)
    }
  }

  private onTailEvent(evt: LogTailEvent): void {
    // Append new lines into the local buffer.
    while (this.lines.length < evt.appendedFromLine) this.lines.push("")
    evt.lines.forEach((line, i) => {
      this.lines[evt.appendedFromLine + i] = line
    })
    this.runtime = {
      totalLines: evt.totalLines,
      totalBytes: evt.totalBytes,
      indexing: false
    }
    this.emit(LogTailingEventName.Update, this.runtime)
  }
}

/** Identity-mapped event names — lets callers use `LogTailingEventName.Update`. */
export enum LogTailingEventName {
  Update = "update",
  PathChanged = "pathChanged"
}

export namespace LogTailingService {
  /** Log category. */
  export const Category = "tui:log-tailing" as const
}
