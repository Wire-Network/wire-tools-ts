import Fs from "node:fs"
import Path from "node:path"

import { FileLogging, type FileLoggingInstallation } from "@wireio/ql-shared/node"
import type { LogRecord } from "@wireio/shared"
import { FileAppender } from "@wireio/shared/node"

/** File logging of the main process and of the records forwarded by renderer/preload. */
export namespace MainLogging {
  /** Main's own log. */
  export const MainLogFilename = "main.log"
  /** Records forwarded from the isolated renderer and the sandboxed preload. */
  export const RendererLogFilename = "renderer.log"

  /**
   * A non-pretty file appender at `<logsPath>/<filename>` (directory created) —
   * the sink of the forwarded renderer/preload records.
   *
   * @param logsPath - The logs directory.
   * @param filename - The log file name.
   * @returns The appender.
   */
  export function createFileAppender(logsPath: string, filename: string): FileAppender<LogRecord> {
    Fs.mkdirSync(logsPath, { recursive: true })
    return new FileAppender<LogRecord>({ filename: Path.join(logsPath, filename), prettyPrint: false, sync: false })
  }

  /**
   * Route every main-process logger to `<logsPath>/main.log` at `LOG_LEVEL`
   * (`FileLogging`, the sink every Node-side QL process shares).
   *
   * @param logsPath - The logs directory.
   * @returns The installation (its level also filters forwarded records; `restore` closes the file).
   */
  export function install(logsPath: string): FileLoggingInstallation {
    return FileLogging.install({ logsPath, filename: MainLogFilename })
  }
}
