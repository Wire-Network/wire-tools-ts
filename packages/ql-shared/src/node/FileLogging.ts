import Fs from "node:fs"
import Path from "node:path"

import { getLoggingManager, Level, LevelNames, type Appender, type LevelKind, type LogRecord } from "@wireio/shared"
import { FileAppender } from "@wireio/shared/node"

/** Options of {@link FileLogging.install}. */
export interface FileLoggingOptions {
  /** Logs directory (created when missing). */
  logsPath: string
  /** Log file name inside {@link logsPath}. */
  filename: string
  /** Root level (default: `LOG_LEVEL` when it names a level, else {@link FileLogging.DefaultLevel}). */
  level?: LevelKind
  /** Environment `LOG_LEVEL` is read from (default `process.env`). */
  environment?: NodeJS.ProcessEnv
}

/** An installed file sink. */
export interface FileLoggingInstallation {
  /** The log file. */
  file: string
  /** The root level in effect. */
  level: LevelKind
  /** The installed appender. */
  appender: FileAppender<LogRecord>
  /**
   * Put back the appenders and root level active before {@link FileLogging.install},
   * then close the file (pending records flushed). Idempotent: every call shares the
   * first call's promise.
   */
  restore(): Promise<void>
}

/**
 * Node-side file logging shared by the wql TUI and the desktop app's processes:
 * every record goes to ONE file and nothing to the terminal.
 */
export namespace FileLogging {
  /** Environment variable naming the root level. */
  export const LevelEnvironmentVariable = "LOG_LEVEL"
  /** Root level when neither the options nor the environment choose one. */
  export const DefaultLevel: LevelKind = Level.info

  /**
   * The level `LOG_LEVEL` names (case-insensitive), else {@link DefaultLevel}.
   *
   * @param environment - The environment (default `process.env`).
   * @returns The level.
   */
  export function levelOf(environment: NodeJS.ProcessEnv = process.env): LevelKind {
    const named = environment[LevelEnvironmentVariable]?.toLowerCase()
    return LevelNames.find(level => level === named) ?? DefaultLevel
  }

  /**
   * Replace every appender with a file appender at `<logsPath>/<filename>` and set
   * the root level.
   *
   * @param options - Directory, file name, level and environment.
   * @returns The installation (its `restore` undoes it and closes the file).
   */
  export function install(options: FileLoggingOptions): FileLoggingInstallation {
    const { logsPath, filename, environment = process.env, level = levelOf(environment) } = options,
      manager = getLoggingManager(),
      previous: Appender[] = [...manager.appenders],
      previousLevel = manager.rootLevel,
      file = Path.join(logsPath, filename)
    Fs.mkdirSync(logsPath, { recursive: true })
    const appender = new FileAppender<LogRecord>({ filename: file, prettyPrint: false, sync: false })
    manager.setAppenders(appender).setRootLevel(level)
    let restored: Promise<void> = null
    const restoreOnce = async (): Promise<void> => {
      manager.setAppenders(previous).setRootLevel(previousLevel)
      await appender.close()
    }
    return { file, level, appender, restore: () => (restored ??= restoreOnce()) }
  }
}
