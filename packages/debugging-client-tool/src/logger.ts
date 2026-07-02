import {
  getLogger,
  getLoggingManager,
  type Appender,
  type Logger,
  type LogRecord
} from "@wireio/shared"

/** Category (prefix) marking a logger whose records are raw stdout — the clean data channel. */
const StdoutCategory = "stdout"
/** Category (prefix) marking a logger whose records are raw stderr. */
const StderrCategory = "stderr"

const hasStream = (category: string, stream: string): boolean =>
  category === stream || category.startsWith(`${stream}:`)

/**
 * The package's single log appender. Routes by category so every channel goes
 * through the framework (no `console.*`, per `use-logging-framework.md`):
 *
 * - a `getStdoutLogger()` logger → its raw message on **stdout** (no
 *   timestamp/level/prefix), so piped data output stays machine-clean. This is
 *   the ONLY place `process.stdout.write` is permitted.
 * - a `getStderrLogger()` logger → its raw message on **stderr**.
 * - every other logger (`getLogger(__filename)` diagnostics) → a formatted line
 *   on **stderr**, keeping stdout a pure data channel.
 *
 * Installed once (module load) via `setAppenders`, preempting the
 * `@wireio/shared` lazy `ConsoleAppender` (which would ALSO print the stdout
 * category and double up the output).
 */
class StdStreamAppender implements Appender {
  append(record: LogRecord): void {
    if (hasStream(record.category, StdoutCategory)) {
      process.stdout.write(record.message + "\n")
      return
    }
    if (hasStream(record.category, StderrCategory)) {
      process.stderr.write(record.message + "\n")
      return
    }
    const args = (record.args ?? [])
      .map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ")
    const suffix = args.length > 0 ? ` ${args}` : ""
    process.stderr.write(
      `[${record.category}] (${record.level}) ${record.message}${suffix}\n`
    )
  }
}

getLoggingManager().setAppenders(new StdStreamAppender())

/**
 * A logger whose records are written RAW to **stdout** — the clean, pipeable
 * data channel (tables, inspect dumps, machine-readable output). Per-file
 * diagnostics still go through `const log = getLogger(__filename)`; this is the
 * separate data channel.
 *
 * @param name - Optional sub-category (`stdout:<name>`); routing is unaffected.
 * @returns The stdout data logger.
 */
export function getStdoutLogger(name?: string): Logger {
  return getLogger(name ? `${StdoutCategory}:${name}` : StdoutCategory)
}

/**
 * A logger whose records are written RAW to **stderr** (unformatted status/data
 * that must bypass the diagnostic formatter but stay off stdout).
 *
 * @param name - Optional sub-category (`stderr:<name>`); routing is unaffected.
 * @returns The stderr raw logger.
 */
export function getStderrLogger(name?: string): Logger {
  return getLogger(name ? `${StderrCategory}:${name}` : StderrCategory)
}
