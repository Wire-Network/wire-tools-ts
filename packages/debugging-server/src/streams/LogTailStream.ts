import {
  buildLineIndex,
  extendLineIndex,
  isPathUnder,
  readLines,
  type LineIndex,
  type LogTailEvent,
  type LogTailParams
} from "@wireio/debugging-shared"

import { log } from "../logging/index.js"

import type { ServerSideStream } from "./ServerSideStream.js"

/**
 * Server-side log-tail. Mirrors the cadence the TUI's `LogTailingService`
 * used to drive locally — 200 ms tick on `extendLineIndex`, emits the
 * appended line slice. Idle ticks (no growth) emit nothing.
 */
export class LogTailStream implements ServerSideStream<LogTailEvent> {
  private timer: NodeJS.Timeout | null = null
  private index: LineIndex | null = null
  private stopped = false

  /**
   * @param params      Path to follow (must resolve under `clusterPath`).
   * @param clusterPath Cluster root used as the path-traversal anchor.
   */
  constructor(
    private readonly params: LogTailParams,
    private readonly clusterPath: string
  ) {}

  async start(emit: (payload: LogTailEvent) => void): Promise<void> {
    if (!isPathUnder(this.params.path, this.clusterPath)) {
      throw new Error(
        `LogTailStream: ${this.params.path} is not under ${this.clusterPath}`
      )
    }
    try {
      this.index = await buildLineIndex(this.params.path)
      // Initial snapshot — emit a 0-line tick carrying current counters
      // so the consumer knows how many lines existed at subscribe time.
      emit({
        path: this.params.path,
        appendedFromLine: 0,
        lines: [],
        totalBytes: this.index.totalBytes,
        totalLines: this.index.completeLineCount,
        ino: this.index.ino
      })
    } catch (err) {
      log.debug(`LogTailStream initial buildLineIndex failed`, err)
    }
    this.timer = setInterval(
      () => void this.tick(emit),
      LogTailStream.PollMs
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(emit: (payload: LogTailEvent) => void): Promise<void> {
    if (this.stopped) return
    try {
      const next = this.index
        ? await extendLineIndex(this.index)
        : await buildLineIndex(this.params.path)
      if (
        this.index &&
        next.totalBytes === this.index.totalBytes &&
        next.ino === this.index.ino
      ) {
        return
      }
      const fromLine = this.index?.completeLineCount ?? 0,
        appendedCount = next.completeLineCount - fromLine,
        lines =
          appendedCount > 0
            ? await readLines(next, fromLine, appendedCount)
            : []
      this.index = next
      emit({
        path: this.params.path,
        appendedFromLine: fromLine,
        lines,
        totalBytes: next.totalBytes,
        totalLines: next.completeLineCount,
        ino: next.ino
      })
    } catch (err) {
      log.debug(`LogTailStream tick failed (transient)`, err)
    }
  }
}

export namespace LogTailStream {
  /** File-growth poll cadence, ms. Mirrors the TUI's prior local cadence. */
  export const PollMs = 200
}
