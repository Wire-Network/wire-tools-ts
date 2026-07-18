import {
  ConsoleAppender,
  getLogger as sharedGetLogger,
  getLoggingManager,
  Level,
  LevelThresholds,
  type LevelKind,
  type Logger,
  type LogRecord
} from "@wireio/shared"
import { LogFileAppender } from "./LogFileAppender.js"

export type { Logger }

/**
 * The harness's single logger entry point — a thin bridge to
 * `@wireio/shared`'s `getLogger`. Every harness module obtains its logger via
 * `getLogger(__filename)` (or an explicit category) so formatting, levels, and
 * appenders are unified across the cluster.
 *
 * @param categoryOrFilename - A category string, or `__filename` to derive one.
 * @returns The cached logger for that category.
 */
export function getLogger(categoryOrFilename: string): Logger {
  return sharedGetLogger(categoryOrFilename)
}

/**
 * Input to {@link configureLogging}. The console and file sinks filter
 * independently; the shared root level is set to the more verbose of the two so
 * neither sink is starved. Distinct from the persisted `ClusterConfigLogging`
 * (`{ levels, fileFormat }`) — this is the runtime setup form, carrying the
 * derived `runLogFile` path.
 */
export interface LoggingSetupOptions {
  /** Minimum level shown on the console. Default `info`. */
  consoleLevel?: LevelKind
  /** Minimum level written to the per-run file. Default `debug`. */
  fileLevel?: LevelKind
  /** Format of the per-run file (`text` or `jsonl`). Default `jsonl`. */
  fileFormat?: LogFileAppender.Format
  /** Absolute path of the per-run structured log file. */
  runLogFile: string
}

/** The more verbose (lower-threshold) of two levels. */
const moreVerbose = (a: LevelKind, b: LevelKind): LevelKind =>
  LevelThresholds[a] <= LevelThresholds[b] ? a : b

/**
 * A console appender that gates on its OWN level. The shared root level carries
 * the union of console + file thresholds, so each appender must re-filter to
 * the level it was configured with.
 */
class LevelConsoleAppender extends ConsoleAppender<LogRecord> {
  constructor(private readonly level: LevelKind) {
    super()
  }

  override append(record: LogRecord): void {
    if (LevelThresholds[record.level] >= LevelThresholds[this.level])
      super.append(record)
  }
}

/**
 * Wire the shared logging manager for a run: set the root level to the union of
 * the console and file levels, then install a level-gated console appender and a
 * per-run {@link LogFileAppender}. Called once by the cluster build / CLI.
 *
 * @param config - Per-run levels, file format, and the run-log path.
 */
export function configureLogging(options: LoggingSetupOptions): void {
  const { consoleLevel = Level.info, fileLevel = Level.debug } = options
  getLoggingManager()
    .setRootLevel(moreVerbose(consoleLevel, fileLevel))
    .setAppenders(
      new LevelConsoleAppender(consoleLevel),
      new LogFileAppender({
        filename: options.runLogFile,
        level: fileLevel,
        format: options.fileFormat ?? LogFileAppender.Format.jsonl
      })
    )
}
