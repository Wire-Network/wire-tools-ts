import { EventEmitter } from "eventemitter3"
import { LoggingManager } from "../../logging/LoggingManager.js"
import { ReduxService } from "../../services/ReduxService.js"
import { ServiceId } from "../../services/ServiceId.js"
import type { Service } from "../../services/Service.js"
import type { ServiceManager } from "../../services/ServiceManager.js"
import { selectLogViewer } from "../../store/process-monitor/ProcessMonitorSelectors.js"
import {
  buildLineIndex,
  extendLineIndex,
  readLines,
  type LineIndex
} from "./util/lineIndex.js"

/**
 * Runtime counters served from the service. These are NOT in Redux — pushing
 * a 200 ms tick through Redux would re-render every store subscriber across
 * the app on every poll. The panel reads this via {@link LogTailingService.getRuntime}
 * and chooses (in component code) whether a particular update should trigger
 * a render.
 */
export interface LogTailingRuntime {
  totalLines: number
  totalBytes: number
  indexing: boolean
}

/**
 * Typed event map for {@link LogTailingService}'s `EventEmitter3` base. Each
 * key is the event name; the value is the listener signature that
 * `EventEmitter3` enforces at compile time.
 */
export interface LogTailingEvents {
  /** Counters or indexing flag changed. */
  update: (runtime: LogTailingRuntime) => void
  /** A new path was selected — pre-load / pre-clear hook for the panel. */
  pathChanged: (next: string | null) => void
}

/**
 * Maintains a per-path line-offset index; panels pull visible windows via
 * {@link LogTailingService.readWindow}. Counters and the active path live on
 * this service (NOT Redux) and are surfaced via typed `EventEmitter3` events
 * so the panel can decide when a particular update warrants a React render
 * (e.g. only while following / on indexing-flag transitions).
 */
export class LogTailingService
  extends EventEmitter<LogTailingEvents>
  implements Service
{
  static readonly id = ServiceId.LogTailing
  static readonly dependsOn: readonly string[] = [
    ServiceId.Redux,
    ServiceId.ProcessMonitor
  ]

  private readonly log = LoggingManager.getLogger(LogTailingService.Category)
  private redux: ReduxService | null = null
  private timer: NodeJS.Timeout | null = null
  private index: LineIndex | null = null
  private currentPath: string | null = null
  private runtime: LogTailingRuntime = {
    totalLines: 0,
    totalBytes: 0,
    indexing: false
  }
  private unsubscribe: (() => void) | null = null

  async init(manager: ServiceManager): Promise<this> {
    this.redux = manager.get<ReduxService>(ServiceId.Redux)
    return this
  }

  async start(_manager: ServiceManager): Promise<this> {
    if (!this.redux) return this
    this.unsubscribe = this.redux.subscribe(() => this.onStoreChange())
    this.timer = setInterval(
      () => void this.tick(),
      LogTailingService.PollMs
    )
    return this
  }

  async stop(_manager: ServiceManager): Promise<this> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.removeAllListeners()
    return this
  }

  /**
   * Visible-window read for panel rendering. `count` is clamped to the
   * complete-line count so the renderer never sees the in-progress trailing
   * line — important for JSONL where a partial line trips the JSON parser
   * and rendered as raw / malformed at the bottom of the viewport.
   */
  async readWindow(from: number, count: number): Promise<string[]> {
    if (!this.index) return []
    const max = this.index.completeLineCount
    if (from >= max) return []
    const safeCount = Math.min(count, max - from)
    return readLines(this.index, from, safeCount)
  }

  /** Current counters snapshot. Cheap — no allocation, returns the live record. */
  getRuntime(): LogTailingRuntime {
    return this.runtime
  }

  /** Redux subscription — rebuild index when the user selects a new path. */
  private onStoreChange(): void {
    if (!this.redux) return
    const viewer = selectLogViewer(this.redux.getState())
    if (viewer.path === this.currentPath) return
    this.currentPath = viewer.path
    this.index = null
    this.runtime = {
      totalLines: 0,
      totalBytes: 0,
      indexing: !!viewer.path
    }
    this.emit(LogTailingEventName.PathChanged, this.currentPath)
    this.emit(LogTailingEventName.Update, this.runtime)
    if (viewer.path) void this.rebuildIndex(viewer.path)
  }

  /** Full rescan. */
  private async rebuildIndex(path: string): Promise<void> {
    try {
      this.index = await buildLineIndex(path)
      this.runtime = {
        totalLines: this.index.completeLineCount,
        totalBytes: this.index.totalBytes,
        indexing: false
      }
    } catch (err) {
      this.log.error(`buildLineIndex failed for ${path}`, err)
      this.runtime = { ...this.runtime, indexing: false }
    }
    this.emit(LogTailingEventName.Update, this.runtime)
  }

  /** 200 ms tail — only work if the file grew. */
  private async tick(): Promise<void> {
    if (!this.index) return
    try {
      const next = await extendLineIndex(this.index)
      if (
        next.totalBytes === this.index.totalBytes &&
        next.ino === this.index.ino
      ) {
        return
      }
      this.index = next
      this.runtime = {
        totalLines: next.completeLineCount,
        totalBytes: next.totalBytes,
        indexing: false
      }
      this.emit(LogTailingEventName.Update, this.runtime)
    } catch (err) {
      this.log.debug("tick failed (transient)", err)
    }
  }
}

/** Identity-mapped event names — lets callers reference the literal as `LogTailingEventName.Update`. */
export enum LogTailingEventName {
  Update = "update",
  PathChanged = "pathChanged"
}

export namespace LogTailingService {
  /** Log category. */
  export const Category = "tui:log-tailing" as const
  /** File-growth poll interval. */
  export const PollMs = 200
}
