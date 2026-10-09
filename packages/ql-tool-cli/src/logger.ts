import { identity } from "lodash"
import { match, P } from "ts-pattern"

import {
  getLogger,
  getLoggingManager,
  Level,
  type Appender,
  type Logger,
  type LogRecord
} from "@wireio/shared"

/** Category (prefix) of a raw stream logger: `stdout` is the clean data channel, `stderr` raw user-facing text. */
export enum StreamCategory {
  stdout = "stdout",
  stderr = "stderr"
}

/** Separator of a stream sub-category (`stdout:<name>`). */
const SubCategorySeparator = ":"

/**
 * Whether `category` is `stream` or a `stream:<name>` sub-category — the routing
 * rule of {@link StdStreamAppender} (tests capture the channels by the same rule).
 *
 * @param category - A log record's category.
 * @param stream - The stream category.
 * @returns Whether the record belongs to that raw stream.
 */
export function hasStream(category: string, stream: StreamCategory): boolean {
  return category === stream || category.startsWith(`${stream}${SubCategorySeparator}`)
}

/**
 * The CLI's routing appender — the ONLY place wql writes to the process streams:
 *
 * - a {@link getStdoutLogger} logger → its raw message on **stdout** (no prefix),
 *   so piped data (`wql … | jq`) stays machine-clean;
 * - a {@link getStderrLogger} logger → its raw message on **stderr**;
 * - every other logger (`getLogger(__filename)` diagnostics) → a formatted
 *   `[category] (level) message` line on **stderr**.
 *
 * Installed by {@link StdStreamAppender.install} when `main` starts (never on
 * import), preempting the lazy `ConsoleAppender` of `@wireio/shared`. The TUI
 * replaces it with a file-only appender (`tui/logging/TuiLogging.ts`) so nothing
 * corrupts the Ink frame.
 */
export class StdStreamAppender implements Appender {
  /**
   * Route one record.
   *
   * @param record - The log record.
   */
  append(record: LogRecord): void {
    match(record.category)
      .with(P.when(category => hasStream(category, StreamCategory.stdout)), () => process.stdout.write(`${record.message}\n`))
      .with(P.when(category => hasStream(category, StreamCategory.stderr)), () => process.stderr.write(`${record.message}\n`))
      .otherwise(category => process.stderr.write(`[${category}] (${record.level}) ${record.message}${StdStreamAppender.argsSuffix(record)}\n`))
  }
}

/** Installation and formatting of {@link StdStreamAppender}. */
export namespace StdStreamAppender {
  /** Separator of a diagnostic record's message and its arguments (and between arguments). */
  export const ArgumentSeparator = " "

  /** Make a new {@link StdStreamAppender} the ONLY appender (idempotent in effect: every call routes the same way). */
  export function install(): void {
    getLoggingManager().setAppenders(new StdStreamAppender())
  }

  /**
   * The arguments of a diagnostic record as a line suffix: each argument (a string
   * as-is, anything else as JSON) after {@link ArgumentSeparator}; empty without arguments.
   *
   * @param record - The log record.
   * @returns The suffix.
   */
  export function argsSuffix(record: LogRecord): string {
    return (record.args ?? [])
      .map(arg =>
        match(arg)
          .with(P.string, identity)
          .otherwise(value => JSON.stringify(value))
      )
      .map(text => `${ArgumentSeparator}${text}`)
      .join("")
  }
}

/**
 * The raw logger of `stream`, or of its `stream:<name>` sub-category; pinned to
 * `trace`, so the diagnostic `--log-level` never filters it.
 *
 * @param stream - The stream category.
 * @param name - Optional sub-category.
 * @returns The logger.
 */
function getStreamLogger(stream: StreamCategory, name?: string): Logger {
  return getLogger(name ? `${stream}${SubCategorySeparator}${name}` : stream).setOverrideLevel(Level.trace)
}

/**
 * A logger whose records are written RAW to **stdout** — the pipeable data
 * channel (rendered results, listings). It is pinned to `trace`, so the
 * diagnostic `--log-level` never filters data out.
 *
 * @param name - Optional sub-category (`stdout:<name>`); routing is unaffected.
 * @returns The stdout data logger.
 */
export function getStdoutLogger(name?: string): Logger {
  return getStreamLogger(StreamCategory.stdout, name)
}

/**
 * A logger whose records are written RAW to **stderr** (user-facing errors and
 * hints that must bypass the diagnostic formatter and stay off stdout). Pinned
 * to `trace` like {@link getStdoutLogger}.
 *
 * @param name - Optional sub-category (`stderr:<name>`); routing is unaffected.
 * @returns The stderr raw logger.
 */
export function getStderrLogger(name?: string): Logger {
  return getStreamLogger(StreamCategory.stderr, name)
}

/**
 * Whether stdout is an interactive terminal (drives the table color default and
 * the TUI guard).
 *
 * @returns `true` only when `process.stdout.isTTY` is exactly `true`.
 */
export function isStdoutTTY(): boolean {
  return process.stdout.isTTY === true
}
