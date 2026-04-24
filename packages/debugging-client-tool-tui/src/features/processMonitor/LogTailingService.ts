import { EventEmitter } from "node:events"
import { LoggingManager } from "../../logging/LoggingManager.js"
import { ReduxService } from "../../services/ReduxService.js"
import { ServiceId } from "../../services/ServiceId.js"
import type { Service } from "../../services/Service.js"
import type { ServiceManager } from "../../services/ServiceManager.js"
import { selectLogViewer } from "../../store/processMonitor/ProcessMonitorSelectors.js"
import {
  buildLineIndex,
  extendLineIndex,
  readLines,
  type LineIndex
} from "./util/lineIndex.js"

/** Runtime counters exposed via event emitter — NOT in Redux (updates at poll rate). */
export interface LogTailingRuntime {
  totalLines: number
  totalBytes: number
  indexing: boolean
}

/** Emitted when runtime changes (new path, growth, or finished indexing). */
export const LogTailingEvent = "update" as const

/**
 * Maintains a per-path line-offset index; panels pull visible windows via
 * `readWindow`. Runtime state is exposed via an `EventEmitter` so Redux doesn't
 * re-render the whole tree on every 200ms poll.
 */
export class LogTailingService extends EventEmitter implements Service {
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

  /** Visible-window read for panel rendering. */
  async readWindow(from: number, count: number): Promise<string[]> {
    if (!this.index) return []
    return readLines(this.index, from, count)
  }

  /** Current counters snapshot. */
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
    this.emit(LogTailingEvent)
    if (viewer.path) void this.rebuildIndex(viewer.path)
  }

  /** Full rescan. */
  private async rebuildIndex(path: string): Promise<void> {
    try {
      this.index = await buildLineIndex(path)
      this.runtime = {
        totalLines: this.index.byteOffsets.length,
        totalBytes: this.index.totalBytes,
        indexing: false
      }
    } catch (err) {
      this.log.error(`buildLineIndex failed for ${path}`, err)
      this.runtime = { ...this.runtime, indexing: false }
    }
    this.emit(LogTailingEvent)
  }

  /** 200ms tail — only work if the file grew. */
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
        totalLines: next.byteOffsets.length,
        totalBytes: next.totalBytes,
        indexing: false
      }
      this.emit(LogTailingEvent)
    } catch (err) {
      this.log.debug("tick failed (transient)", err)
    }
  }
}

export namespace LogTailingService {
  /** Log category. */
  export const Category = "tui:log-tailing" as const
  /** File-growth poll interval. */
  export const PollMs = 200
}
