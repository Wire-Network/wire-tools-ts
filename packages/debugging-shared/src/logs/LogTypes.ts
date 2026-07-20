import { SchemaCodec } from "@wireio/cluster-tool-shared"
import { z } from "zod"

/**
 * Log file statistics. Mirrors the in-memory `LineIndex` counters but as a
 * wire-friendly snapshot — the index itself stays server-side.
 */
export interface LogStat {
  /** Absolute path on the producing machine. Treated as opaque by remote clients. */
  path: string
  /** Inode at last scan. Surfaced so clients can detect rotation across reads. */
  ino: number
  /** Total file size in bytes at last scan. */
  totalBytes: number
  /**
   * Lines that ended in `\n` at scan time. Bounds safe windowed reads —
   * partial trailing lines stay hidden until flushed.
   */
  totalLines: number
}

/** Request body for `Logs.GetStat`. */
export interface LogStatRequest {
  /** Absolute path of the log file. Server validates containment under its `clusterPath`. */
  path: string
}

/** Response body for `Logs.GetStat`. */
export type LogStatResponse = LogStat

/** Request body for `Logs.Read` — random-access window into a log file. */
export interface LogReadRequest {
  /** Absolute path on the server. */
  path: string
  /** Inclusive line index of the first line to return. */
  fromLine: number
  /** Maximum line count; truncated when the file ends sooner. */
  count: number
}

/** Response body for `Logs.Read`. */
export interface LogReadResponse {
  /**
   * Lines as raw strings — no trailing `\n`. Clients that want JSONL records
   * should `parseJsonLogLine()` (see `JsonLogRecord`) per line.
   */
  lines: string[]
}

/** Subscribe params for the `LogTail` stream topic. */
export interface LogTailParams {
  /** Absolute path on the server to follow. */
  path: string
}

/**
 * Stream event for the `LogTail` subscription. Emitted whenever the file's
 * line count grows; carries only the appended slice plus updated counters
 * so the client can extend its own visible state without re-reading the
 * whole file.
 */
export interface LogTailEvent {
  /** Path the event pertains to (echoed for routing in multi-subscription clients). */
  path: string
  /** First line index in `lines` — equal to the previous tick's `totalLines`. */
  appendedFromLine: number
  /** Newly-appended complete lines. */
  lines: string[]
  /** New total file size in bytes. */
  totalBytes: number
  /** New complete-line count after this tick. */
  totalLines: number
  /** Inode at the time of this tick — change implies log rotation. */
  ino: number
}

// ---------------------------------------------------------------------------
//  Zod schemas + codecs (validated plain-JSON RPC bodies for Logs.GetStat/Read)
// ---------------------------------------------------------------------------

/** Schema for a {@link LogStat} / {@link LogStatResponse}. */
export const LogStatSchema = z.object({
  path: z.string(),
  ino: z.number(),
  totalBytes: z.number(),
  totalLines: z.number()
})
/** Codec for the `Logs.GetStat` response body ({@link LogStatResponse} = {@link LogStat}). */
export const LogStatResponseSchemaCodec =
  SchemaCodec.create<LogStatResponse>(LogStatSchema)

/** Schema for {@link LogStatRequest}. */
export const LogStatRequestSchema = z.object({ path: z.string() })
/** Codec for the `Logs.GetStat` request body. */
export const LogStatRequestSchemaCodec =
  SchemaCodec.create<LogStatRequest>(LogStatRequestSchema)

/** Schema for {@link LogReadRequest}. */
export const LogReadRequestSchema = z.object({
  path: z.string(),
  fromLine: z.number(),
  count: z.number()
})
/** Codec for the `Logs.Read` request body. */
export const LogReadRequestSchemaCodec =
  SchemaCodec.create<LogReadRequest>(LogReadRequestSchema)

/** Schema for {@link LogReadResponse}. */
export const LogReadResponseSchema = z.object({ lines: z.array(z.string()) })
/** Codec for the `Logs.Read` response body. */
export const LogReadResponseSchemaCodec =
  SchemaCodec.create<LogReadResponse>(LogReadResponseSchema)
