import { Either } from "@3fv/prelude-ts"
import { identity } from "lodash"
import { SchemaCodec } from "@wireio/cluster-tool-shared"
import { match } from "ts-pattern"
import { z } from "zod"

/**
 * One nodeop JSONL log line, post-`JSON.parse`. Fields mirror the C++
 * `daily_file_sink` JSON formatter — see `wire-sysio/programs/nodeop/logging.json`
 * for the schema reference.
 */
export interface JsonLogRecord {
  /** ISO-8601 timestamp, e.g. `"2026-04-27T19:58:15.417594Z"`. */
  ts: string
  /** Log level, e.g. `"debug"`, `"info"`, `"warn"`, `"error"`. */
  lvl: string
  /** Originating thread name (almost always `"nodeop"`). */
  thread: string
  /** Logger category, e.g. `"default"`, `"net_plugin_impl"`. */
  logger: string
  /** Source file path of the emitting log call. */
  file: string
  /** Source line number of the emitting log call. */
  line: number
  /** Function name of the emitting log call. */
  func: string
  /** The actual log message. */
  msg: string
}

/**
 * Identity-mapped log levels emitted by the nodeop JSON formatter. Lowercase
 * matches the on-the-wire shape verbatim so `match()` can compare without
 * casts.
 */
export enum JsonLogLevel {
  trace = "trace",
  debug = "debug",
  info = "info",
  warn = "warn",
  error = "error",
  fatal = "fatal"
}

/**
 * Identity-mapped Ink color names used to colorize log levels. Identity
 * mapping keeps the value identical to Ink's accepted string set.
 */
export enum LogLevelColor {
  gray = "gray",
  yellow = "yellow",
  red = "red",
  redBright = "redBright"
}

export namespace JsonLogRecord {
  /** Minimum length of an ISO-8601 timestamp that carries `HH:mm:ss.SSS`. */
  export const TimestampMinLength = 23
  /** Char index where the time-of-day component begins in an ISO-8601 string. */
  export const TimeOfDayStartIndex = 11
  /** Char index (exclusive) where the millisecond-precision time-of-day ends. */
  export const TimeOfDayEndIndex = 23
}

/**
 * Zod schema for a nodeop JSONL log record — every field the C++
 * `daily_file_sink` formatter emits. Bound to {@link JsonLogRecord} via the
 * explicit codec generic below (the companion namespace precludes `z.infer`),
 * so a drift between the two fails the build.
 */
export const JsonLogRecordSchema = z.object({
  ts: z.string(),
  lvl: z.string(),
  thread: z.string(),
  logger: z.string(),
  file: z.string(),
  line: z.number(),
  func: z.string(),
  msg: z.string()
})

/** The {@link SchemaCodec} for {@link JsonLogRecord} — a validated JSONL round-trip. */
export const JsonLogRecordSchemaCodec = SchemaCodec.create<JsonLogRecord>(
  JsonLogRecordSchema
)

/**
 * Parse a single JSONL line into a validated {@link JsonLogRecord}. Returns the
 * raw string when the line is not valid JSON or does not validate as a full
 * record (via {@link JsonLogRecordSchemaCodec}) — callers always receive
 * something printable.
 */
export function parseJsonLogLine(raw: string): JsonLogRecord | string {
  if (raw.length === 0) return raw
  return Either.try(() => JsonLogRecordSchemaCodec.deserialize(raw)).match({
    Left: (): JsonLogRecord | string => raw,
    Right: identity
  })
}

/** Ink color for a JSONL `lvl` field. Unrecognized values render in default fg. */
export function colorForLevel(lvl: string): LogLevelColor | undefined {
  return match(lvl.toLowerCase())
    .with(JsonLogLevel.trace, () => LogLevelColor.gray)
    .with(JsonLogLevel.debug, () => LogLevelColor.gray)
    .with(JsonLogLevel.info, () => undefined)
    .with(JsonLogLevel.warn, () => LogLevelColor.yellow)
    .with(JsonLogLevel.error, () => LogLevelColor.red)
    .with(JsonLogLevel.fatal, () => LogLevelColor.redBright)
    .otherwise(() => undefined)
}

/**
 * `HH:mm:ss.SSS` slice of the record's `ts` field.
 *
 * @example `formatTimestamp("2026-04-27T19:58:15.417594Z")` returns `"19:58:15.417"`
 */
export function formatTimestamp(ts: string): string {
  return ts.length >= JsonLogRecord.TimestampMinLength
    ? ts.slice(JsonLogRecord.TimeOfDayStartIndex, JsonLogRecord.TimeOfDayEndIndex)
    : ts
}

/**
 * Compact source-location label — just `basename:line`. The full path is
 * stripped so the column stays narrow; full path is still on disk in the
 * underlying record if a debugger ever wants it.
 *
 * @example `formatLocation({ file: "/.../signature_provider.cpp", line: 426 })` returns `"signature_provider.cpp:426"`
 */
export function formatLocation(record: JsonLogRecord): string {
  const slash = record.file.lastIndexOf("/"),
    basename = slash === -1 ? record.file : record.file.slice(slash + 1)
  return `${basename}:${record.line}`
}
