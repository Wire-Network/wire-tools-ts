import { Console } from "node:console"

/**
 * Module-local logger for harness internals.
 *
 * Currently a raw `node:console` instance, which means no structured fields,
 * levels, or timestamps — output goes straight to stdout/stderr. Replacing
 * this with `getLogger()` from `@wireio/shared` would unify formatting with
 * `debugging-server`, at the cost of an extra dependency edge.
 */
export const log = new Console(process.stdout, process.stderr)
