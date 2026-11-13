import type { Appender, LogRecord } from "@wireio/shared"

/**
 * Plain stdout appender — writes the raw `record.message` (no timestamp / level
 * / category prefix) for the dedicated {@link StdoutAppender.Category} category
 * (and its `stdout:<name>` sub-categories) only, so piped CLI output stays
 * machine-clean. Records of any other category fall through to the framework's
 * other appenders.
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
    if (!StdoutAppender.isStdoutCategory(record.category)) return
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

  /** Separator between {@link Category} and a sub-category name (`stdout:<name>`). */
  export const SubCategorySeparator = ":"

  /**
   * Whether `category` is the stdout channel — the category itself or one of
   * its `stdout:<name>` sub-categories.
   *
   * @param category - A log record's category.
   * @returns `true` for the stdout channel.
   */
  export function isStdoutCategory(category: string): boolean {
    return (
      category === Category ||
      category.startsWith(`${Category}${SubCategorySeparator}`)
    )
  }

  /**
   * The category of a stdout data logger — {@link Category}, or
   * `stdout:<name>` when a sub-category names the data channel.
   *
   * @param name - Optional sub-category name.
   * @returns The category.
   */
  export function category(name?: string): string {
    return name == null ? Category : `${Category}${SubCategorySeparator}${name}`
  }
}
