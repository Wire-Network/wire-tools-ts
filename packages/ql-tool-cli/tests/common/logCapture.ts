import { getLoggingManager, type Appender, type LogRecord } from "@wireio/shared"

import { hasStream, StreamCategory } from "@wireio/ql-tool-cli/logger.js"

/** Captured log records with stream helpers. */
export interface CapturedLogs {
  /** Every record. */
  records: LogRecord[]
  /** Messages of the raw stdout channel. */
  stdout(): string[]
  /** Messages of the raw stderr channel. */
  stderr(): string[]
  /** Restore the previous appenders. */
  restore(): void
}

/**
 * Replace the appenders with an in-memory capture (restore() puts them back);
 * the channels split by the routing appender's own rule ({@link hasStream}).
 *
 * @returns The capture.
 */
export function captureLogs(): CapturedLogs {
  const manager = getLoggingManager(),
    previous: Appender[] = [...manager.appenders],
    records: LogRecord[] = [],
    capture: Appender = { append: record => records.push(record) },
    messagesOf = (stream: StreamCategory) => records.filter(record => hasStream(record.category, stream)).map(record => record.message)
  manager.setAppenders(capture)
  return {
    records,
    stdout: () => messagesOf(StreamCategory.stdout),
    stderr: () => messagesOf(StreamCategory.stderr),
    restore: () => manager.setAppenders(previous)
  }
}
