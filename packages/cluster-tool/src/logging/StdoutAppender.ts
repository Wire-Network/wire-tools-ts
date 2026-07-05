import type { Appender, LogRecord } from "@wireio/shared"

/**
 * Plain stdout appender — writes the raw `record.message` (no timestamp / level
 * / category prefix) for the dedicated {@link StdoutAppender.Category} category
 * only, so piped CLI output stays machine-clean. Records of any other category
 * fall through to the framework's other appenders.
 *
 * This is the ONLY place in the harness where `process.stdout.write` is
 * permitted — every other output path goes through the logging framework.
 */
export class StdoutAppender implements Appender {
  /**
   * Write `record.message` raw to stdout when it belongs to the stdout
   * category; otherwise do nothing (other appenders handle it).
   *
   * @param record - The log record to consider.
   */
  append(record: LogRecord): void {
    if (record.category !== StdoutAppender.Category) return
    process.stdout.write(record.message + "\n")
  }
}

export namespace StdoutAppender {
  /**
   * The logging category whose records are written raw to stdout. A logger
   * obtained via `getLogger(StdoutAppender.Category)` is the clean CLI-output
   * channel; changing this string re-routes that channel.
   */
  export const Category = "stdout"
}
