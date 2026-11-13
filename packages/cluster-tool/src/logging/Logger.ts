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
import { StdoutAppender } from "./StdoutAppender.js"

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
 * A logger whose records are written RAW to **stdout** — the clean, pipeable
 * data channel of a CLI command (a listing, a JSON document). Routed by
 * {@link StdoutAppender}, which {@link configureCommandLogging} installs;
 * per-file diagnostics still go through `const log = getLogger(__filename)`.
 *
 * @param name - Optional sub-category (`stdout:<name>`); routing is unaffected.
 * @returns The stdout data logger.
 */
export function getStdoutLogger(name?: string): Logger {
  return sharedGetLogger(StdoutAppender.category(name))
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
 * the level it was configured with. The stdout DATA channel is never formatted
 * here — {@link StdoutAppender} owns it raw, and printing it formatted too
 * would double every data line.
 */
class LevelConsoleAppender extends ConsoleAppender<LogRecord> {
  constructor(private readonly level: LevelKind) {
    super()
  }

  override append(record: LogRecord): void {
    if (StdoutAppender.isStdoutCategory(record.category)) return
    if (LevelThresholds[record.level] >= LevelThresholds[this.level])
      super.append(record)
  }
}

/**
 * {@link LevelConsoleAppender} for a CLUSTER-LESS command: every diagnostic
 * line goes to STDERR whatever its level. The command's stdout is the raw DATA
 * channel ({@link StdoutAppender}) a caller captures whole —
 * `create-batch-operator-keys > listing.json` — and Node routes
 * `console.info` / `log` / `debug` to stdout, so a level-routed diagnostic
 * would land inside the capture. Every line is therefore written through the
 * base appender's `error` binding — `console.error`, which Node sends to
 * stderr — so the console is still reached only by the shared
 * `ConsoleAppender`.
 */
class StderrConsoleAppender extends LevelConsoleAppender {
  protected override write(_level: LevelKind, ...args: any[]): void {
    super.write(Level.error, ...args)
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

/**
 * Wire the shared logging manager for a CLUSTER-LESS command (no run log):
 * level-gated diagnostics go to STDERR at every level
 * ({@link StderrConsoleAppender}), and stdout carries ONLY the raw data channel
 * ({@link getStdoutLogger} → {@link StdoutAppender}), so a caller can capture
 * stdout whole as the command's deliverable. Installing explicitly preempts
 * `@wireio/shared`'s lazy default console appender, which would print the data
 * channel formatted as well.
 *
 * @param consoleLevel - Minimum diagnostic level written to stderr. Default `info`.
 */
export function configureCommandLogging(consoleLevel: LevelKind = Level.info): void {
  getLoggingManager()
    .setRootLevel(consoleLevel)
    .setAppenders(new StderrConsoleAppender(consoleLevel), new StdoutAppender())
}
