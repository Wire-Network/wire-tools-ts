import type { Middleware } from "@reduxjs/toolkit"
import { Level } from "@wireio/shared"
import { createLogger } from "redux-logger"
import { LoggingManager } from "../../logging/LoggingManager.js"

/**
 * Console-shim handed to `redux-logger` so its formatted output lands in
 * `tui.log` instead of `process.stdout` (which Ink owns and would visibly
 * corrupt). Methods we don't model — `group`, `groupCollapsed`, `groupEnd` —
 * are no-ops; redux-logger uses them to nest output, but flat lines through
 * the file logger read fine and avoid duplicating the title string.
 */
interface FileConsoleShim {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  group(...args: unknown[]): void
  groupCollapsed(...args: unknown[]): void
  groupEnd(): void
}

/**
 * Stringify a redux-logger argv tuple. Strings pass through; everything else
 * goes through a safe JSON serializer that turns `BigInt` into decimal
 * strings and `Uint8Array`/`Buffer` into base64 — keeps the line short and
 * avoids `JSON.stringify` throwing on bigint fields that protobuf-decoded
 * messages routinely carry.
 */
function stringifyArgs(args: readonly unknown[]): string {
  return args.map(a => (typeof a === "string" ? a : safeJson(a))).join(" ")
}

/** JSON-stringify with safe replacements for `BigInt` and binary buffers. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) =>
      typeof v === "bigint"
        ? v.toString()
        : v instanceof Uint8Array
          ? `<bytes:${v.byteLength}>`
          : v
    )
  } catch (err) {
    return `<unserializable: ${(err as Error).message ?? String(err)}>`
  }
}

/**
 * True when the redux-logger category is currently logging at debug level
 * or finer. Wrapped in try/catch because `LoggingManager.getLogger` throws
 * before `LoggingManager.configure` has run — the store module loads before
 * `main()` runs, so the predicate gets called pre-configure during the
 * initial setCluster / registerFeature dispatches.
 */
function isReduxLoggingEnabled(): boolean {
  try {
    return LoggingManager.getLogger(ReduxFileLogger.Category).isDebugEnabled()
  } catch {
    return false
  }
}

/**
 * Construct the FileConsoleShim. Each method tries to dispatch through the
 * shared logger; if logging hasn't been configured yet (early-boot dispatches
 * before `main()` runs `LoggingManager.configure`) the call is silently
 * dropped so we don't crash the store.
 */
function createFileConsoleShim(): FileConsoleShim {
  const safeLog = (
    level: Level.debug | Level.info | Level.warn | Level.error,
    args: unknown[]
  ): void => {
    try {
      LoggingManager.getLogger(ReduxFileLogger.Category)[level](
        stringifyArgs(args)
      )
    } catch {
      /* swallow — pre-configure dispatches end up here */
    }
  }
  return {
    log: (...args) => safeLog(Level.debug, args),
    error: (...args) => safeLog(Level.error, args),
    warn: (...args) => safeLog(Level.warn, args),
    info: (...args) => safeLog(Level.info, args),
    // group / groupCollapsed: emit the title as a debug line so we don't
    // lose context; groupEnd is a no-op.
    group: (...args) => safeLog(Level.debug, args),
    groupCollapsed: (...args) => safeLog(Level.debug, args),
    groupEnd: () => {}
  }
}

/**
 * Build a redux middleware that pipes `redux-logger` output to `tui.log`
 * via {@link LoggingManager}. The middleware is always installed; it
 * activates per-dispatch only when the redux logger category is at debug
 * level or finer (i.e. when the user passed `--log-level debug`). When
 * inactive it short-circuits in `redux-logger`'s own predicate before any
 * formatting happens, so the runtime cost is one boolean check per action.
 */
export function createReduxFileLogger(): Middleware {
  return createLogger({
    logger: createFileConsoleShim(),
    // ANSI escape codes would garble file output. The shim writes plain
    // text only.
    colors: false,
    // Single-line title rather than nested groups (we no-op group anyway).
    collapsed: true,
    // Skip prevState/nextState — the OPP slice can hold up to 1 000 epoch
    // records at multi-MB sizes; serializing the full state per dispatch
    // would dwarf the actual log signal. We log only the action.
    level: {
      prevState: false,
      action: "log",
      nextState: false,
      error: "error"
    },
    // Diff would also serialize the full state. Off.
    diff: false,
    predicate: isReduxLoggingEnabled
  })
}

export namespace ReduxFileLogger {
  /** Logger category used for redux-logger output. */
  export const Category = "tui:redux" as const
}
