import { identity } from "lodash"
import { match, P } from "ts-pattern"

import { getLoggingManager, getValue, Level, type Appender, type LogRecord } from "@wireio/shared"

import type { LogRecordPayload } from "../IPCContract.js"

/** Delivers one serialized record to main (bridge `send` or `ipcRenderer.send`). */
export type LogRecordSink = (payload: LogRecordPayload) => void

/**
 * Appender for the processes without file access (sandboxed preload, isolated
 * renderer): every record is reduced to a structured-clone-safe
 * {@link LogRecordPayload} — its category is the sender's own
 * `getLogger(__filename)` category — and handed to main's `LogHandlers`, which
 * applies `LOG_LEVEL` and writes it with a file appender.
 */
export class BridgeLogAppender implements Appender {
  /**
   * @param sink - Where payloads go (e.g. `payload => bridge.send(IPCChannel.log, payload)`).
   */
  constructor(readonly sink: LogRecordSink) {}

  /**
   * Forward one record.
   *
   * @param record - The logger's record.
   */
  append(record: LogRecord): void {
    this.sink(BridgeLogAppender.toPayload(record))
  }
}

/** Installation + record conversion. */
export namespace BridgeLogAppender {
  /** Separator between the message and stringified extra arguments. */
  export const ArgumentSeparator = " "
  /**
   * Root level of a forwarding process: every record is forwarded, because the
   * sandboxed / isolated processes cannot read `LOG_LEVEL` — main filters the
   * forwarded records by it.
   */
  export const ForwardingLevel = Level.trace

  /**
   * Route every logger of this process through one bridge appender (the
   * preload and the renderer install it before their first log write).
   *
   * @param sink - Where payloads go.
   * @returns The installed appender.
   */
  export function install(sink: LogRecordSink): BridgeLogAppender {
    const appender = new BridgeLogAppender(sink)
    getLoggingManager().setAppenders(appender).setRootLevel(ForwardingLevel)
    return appender
  }

  /**
   * Reduce a record to its serializable payload (extra arguments are appended to
   * the message as text — errors by their stack, so the trace survives the hop).
   *
   * @param record - The logger's record.
   * @returns The payload.
   */
  export function toPayload(record: LogRecord): LogRecordPayload {
    const { category, level, message, timestamp, args = [] } = record,
      extra = args.map(describeArgument)
    return {
      category,
      level: level as Level,
      message: [String(message), ...extra].join(ArgumentSeparator),
      timestamp
    }
  }

  /**
   * Text of one extra log argument: an error's stack (its message when the
   * runtime gave it none), a string as-is, anything else as JSON with bigints
   * as decimal strings (a value JSON cannot encode — a cycle, `undefined` — by `String`).
   *
   * @param argument - Any logged value.
   * @returns Its text.
   */
  export function describeArgument(argument: unknown): string {
    return match(argument)
      .with(P.instanceOf(Error), error => error.stack ?? error.message)
      .with(P.string, identity)
      .otherwise(value => getValue(() => JSON.stringify(value, jsonReplacer) ?? String(value), String(value)))
  }

  /**
   * `JSON.stringify` replacer encoding bigints as decimal strings.
   *
   * @param _key - The member name.
   * @param value - The member value.
   * @returns The value to encode.
   */
  function jsonReplacer(_key: string, value: unknown): unknown {
    return match(value)
      .with(P.bigint, big => big.toString())
      .otherwise(identity)
  }
}
