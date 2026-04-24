import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { defaults } from "lodash"
import {
  getLoggingManager,
  type Level,
  type Logger
} from "@wireio/shared"
import { FileAppender } from "@wireio/shared/node"

/**
 * File-only logging configuration for the TUI.
 *
 * `configure()` MUST run in `main()` before any `getLogger()` call. Module-scope
 * `getLogger(...)` is forbidden — call it in a service's field initializer or
 * inside `init()` so the call happens after `configure()` has set the
 * `FileAppender` and preempted the `@wireio/shared` lazy `ConsoleAppender` that
 * would otherwise corrupt Ink's frame buffer.
 */
export namespace LoggingManager {
  /** Global (category-less) logger category name. */
  export const GlobalCategory = "tui" as const
  /** Default root level when `--log-level` is omitted. */
  export const DefaultLevel = "info" as Level
  /** Max bytes before rolling — 5 MiB keeps a single-session log bounded. */
  export const RollSizeBytes = 5 * 1_024 * 1_024
  /** Retained rolling files. Changing this affects how far back log history is preserved. */
  export const MaxFiles = 4
  /** Relative subpath under `<clusterPath>` where tui.log is written. */
  export const LogSubpath = "data/tui/logs" as const
  /** Log filename inside `LogSubpath`. */
  export const LogFilename = "tui.log" as const

  /** Caller-facing options for {@link configure}. All optional. */
  export interface ConfigureOptions {
    /** Absolute cluster directory. Required when `filename` is not supplied. */
    clusterPath?: string
    /** Root log level. Defaults to {@link DefaultLevel}. */
    level?: Level
    /** Explicit log filename; overrides the default `<clusterPath>/<LogSubpath>/<LogFilename>` path. */
    filename?: string
  }

  /** Fully-resolved logging configuration consumed internally. */
  export interface Config extends Required<ConfigureOptions> {}

  let configured = false

  /**
   * Resolve caller options into a full {@link Config}, filling in defaults and
   * deriving the log filename when absent.
   *
   * @param options caller-provided partial options
   * @return fully-populated config with every field required downstream
   */
  function resolveConfig(options: ConfigureOptions): Config {
    Assert.ok(
      options.filename || options.clusterPath,
      "LoggingManager.configure: clusterPath or filename is required"
    )
    const filename =
      options.filename ??
      Path.join(options.clusterPath as string, LogSubpath, LogFilename)
    return defaults(
      { ...options, filename },
      { clusterPath: options.clusterPath ?? "", level: DefaultLevel }
    ) as Config
  }

  /**
   * Point every `@wireio/shared` logger at a file under the cluster directory
   * and set the root level. Idempotent — subsequent calls are no-ops.
   *
   * @param options partial configuration; see {@link ConfigureOptions}
   */
  export function configure(options: ConfigureOptions): void {
    if (configured) return
    const config = resolveConfig(options)
    Fs.mkdirSync(Path.dirname(config.filename), { recursive: true })
    const appender = new FileAppender({
      filename: config.filename,
      enableRolling: true,
      maxFiles: MaxFiles,
      maxSize: RollSizeBytes,
      prettyPrint: false,
      sync: false
    })
    getLoggingManager().setAppenders(appender).setRootLevel(config.level)
    configured = true
  }

  /**
   * Fetch a category logger. Throws if {@link configure} hasn't run — this
   * prevents the `@wireio/shared` lazy `ConsoleAppender` from attaching and
   * corrupting Ink.
   *
   * @param category category name, e.g. `"tui:opp-tracking"`
   * @return shared `Logger` bound to the given category
   */
  export function getLogger(category: string): Logger {
    Assert.ok(configured, "LoggingManager.getLogger called before configure()")
    return getLoggingManager().getLogger(category)
  }

  /** Convenience for the category-less TUI logger. */
  export function getGlobalLogger(): Logger {
    return getLogger(GlobalCategory)
  }
}

/** Named re-exports so callers don't have to type `LoggingManager.`. */
export const getLogger = LoggingManager.getLogger
/** Global logger — category `"tui"`. */
export const getGlobalLogger = LoggingManager.getGlobalLogger
export type { Logger, Level } from "@wireio/shared"
