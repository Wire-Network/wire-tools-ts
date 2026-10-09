import { FileLogging, QLPaths, type FileLoggingInstallation } from "@wireio/ql-shared/node"
import type { LevelKind } from "@wireio/shared"

/** Options of {@link TuiLogging.install} (all optional). */
export interface TuiLoggingOptions {
  /** Log directory (default `QLPaths.logsPath()`). */
  logsPath?: string
  /** Root level (default: `LOG_LEVEL`, else `FileLogging.DefaultLevel`). */
  level?: LevelKind
}

let installation: FileLoggingInstallation = null

/**
 * File-only logging for the TUI: every record goes to `<logs>/tui.log` and
 * NOTHING to the terminal (a stray write would corrupt the Ink frame) — the
 * shared {@link FileLogging} sink. Replaces the CLI's stream appender for the
 * TUI's lifetime; `restore()` puts it back and awaits the log file's close.
 */
export namespace TuiLogging {
  /** Log file name under the logs directory. */
  export const LogFilename = "tui.log"

  /**
   * Install the file sink (idempotent: a second call returns the first installation
   * until it is restored).
   *
   * @param options - Directory and level.
   * @returns The installation.
   */
  export function install(options: TuiLoggingOptions = {}): FileLoggingInstallation {
    if (installation != null) return installation
    const { logsPath = QLPaths.logsPath(), level } = options,
      installed = FileLogging.install({ logsPath, filename: LogFilename, level }),
      current: FileLoggingInstallation = {
        ...installed,
        restore: () => {
          if (installation === current) installation = null
          return installed.restore()
        }
      }
    installation = current
    return current
  }
}
