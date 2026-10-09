import type { Argv, CommandModule } from "yargs"

import { Deferred } from "@wireio/shared"

import { applyConnectionArgs, type ConnectionOptions } from "../args/index.js"
import type { CliContext } from "../context/index.js"
import { QLCli, type GlobalOptions } from "../QLCli.js"
import { QLCommand } from "./QLCommand.js"

/** The lazily loaded TUI module (its own bundle chunk: Ink/React load only for `wql tui`). */
export type TuiModule = typeof import("../../tui/index.js")

/** Parsed flags of `wql tui [query]`. */
export interface TuiCommandArgs extends GlobalOptions, ConnectionOptions {
  /** SQL that pre-fills the editor. */
  query?: string
}

let tuiModule: Deferred<TuiModule> | null = null

/**
 * Lazily import the TUI once; concurrent callers share the one in-flight import
 * (the Deferred is assigned synchronously). A failed import is reported to every
 * waiter and cleared so a later call retries.
 *
 * @returns The TUI module.
 */
export function importTuiModule(): Promise<TuiModule> {
  if (tuiModule === null) {
    const loading = new Deferred<TuiModule>()
    tuiModule = loading
    import("../../tui/index.js")
      .then(loaded => loading.resolve(loaded))
      .catch(error => {
        tuiModule = null
        loading.reject(error)
      })
  }
  return tuiModule.promise
}

/**
 * `wql tui [query]` — the terminal workbench (also the `wire-ql-tui` bin).
 *
 * @param context - The run context.
 * @returns The yargs command module.
 */
export function createTuiCommand(context: CliContext): CommandModule<object, TuiCommandArgs> {
  return {
    command: `${QLCommand.tui} [query]`,
    describe: "open the interactive terminal workbench",
    builder: (yargs: Argv) =>
      applyConnectionArgs(
        yargs.positional("query", { type: "string", describe: "SQL that pre-fills the editor" })
      ) as unknown as Argv<TuiCommandArgs>,
    handler: QLCli.handle(context, async argv => {
      const { runTui } = await importTuiModule()
      context.exitCode = await runTui({ context, connection: argv, query: argv.query, logLevel: argv.logLevel })
    })
  }
}
