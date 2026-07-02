import Fs from "node:fs"
import Path from "node:path"
import {
  LevelThresholds,
  type Appender,
  type LevelKind,
  type LogRecord
} from "@wireio/shared"
import { mkdirs } from "../utils/fsUtils.js"

/**
 * Construction options for a {@link LogFileAppender}. `Options`, not a
 * `Partial<LogFileAppender>` — the appender owns its stream, the caller owns
 * the configuration.
 */
export interface LogFileAppenderOptions {
  /** Absolute path of the file to append records to. */
  filename: string
  /** Minimum level to write; records below this threshold are dropped. */
  level: LevelKind
  /** Built-in format to use when no explicit `formatter` is supplied. */
  format?: LogFileAppender.Format
  /** Override the built-in `text`/`jsonl` formatter with a custom one. */
  formatter?: LogFileAppender.Formatter
}

/**
 * Appends (level-filtered) log records to a single file as either human-readable
 * text or one-JSON-object-per-line (`jsonl`). Created once per run under the
 * report directory; `jsonl` output is `jq`/`lnav`-friendly.
 */
export class LogFileAppender implements Appender {
  private stream: Fs.WriteStream | null = null
  private readonly format: LogFileAppender.Formatter

  /**
   * Bind the formatter from `options.formatter` or the `options.format`
   * built-in. The file stream is opened lazily on the first record that passes
   * the level filter — an appender that is configured but never written to
   * touches no disk.
   *
   * @param options - File path, level threshold, and format selection.
   */
  constructor(private readonly options: LogFileAppenderOptions) {
    this.format =
      options.formatter ??
      (options.format === LogFileAppender.Format.text
        ? LogFileAppender.textFormatter
        : LogFileAppender.jsonlFormatter)
  }

  /** Open the append-mode stream on first use, creating parent directories. */
  private ensureStream(): Fs.WriteStream {
    if (this.stream) return this.stream
    mkdirs(Path.dirname(this.options.filename))
    const stream = Fs.createWriteStream(this.options.filename, { flags: "a" })
    // Last resort: the logging sink itself failed — surface on stderr, since
    // the logger cannot log its own file-stream error without recursing.
    stream.on("error", error =>
      process.stderr.write(
        `LogFileAppender(${this.options.filename}) stream error: ${error instanceof Error ? error.message : String(error)}\n`
      )
    )
    this.stream = stream
    return stream
  }

  /**
   * Write `record` to the file when it meets the configured level threshold
   * (opening the stream on the first such record).
   *
   * @param record - The log record to consider.
   */
  append(record: LogRecord): void {
    if (LevelThresholds[record.level] < LevelThresholds[this.options.level])
      return
    this.ensureStream().write(this.format(record) + "\n")
  }

  /** Flush and close the underlying file stream, if it was opened. */
  close(): void {
    this.stream?.end()
  }
}

export namespace LogFileAppender {
  /**
   * File format. `jsonl` (one JSON object per line) is the default — it is
   * grep-/`jq`-friendly; `text` is the human-readable console-style form.
   */
  export enum Format {
    text = "text",
    jsonl = "jsonl"
  }

  /** Turns one log record into its on-disk line (newline added by the appender). */
  export type Formatter = (record: LogRecord) => string

  /** Console-style line prefixed with an ISO timestamp. */
  export const textFormatter: Formatter = record => {
    const ts = new Date(record.timestamp).toISOString(),
      args = (record.args ?? [])
        .map(arg => (typeof arg === "string" ? arg : JSON.stringify(arg)))
        .join(" "),
      err = record.errorStack ? `\n${record.errorStack}` : ""
    return `${ts} [${record.category}] (${record.level}) ${record.message}${args ? " " + args : ""}${err}`
  }

  /** The full record as one JSON object per line. */
  export const jsonlFormatter: Formatter = record => JSON.stringify(record)
}
