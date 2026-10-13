import { identity } from "lodash"
import type { Argv, CommandModule } from "yargs"

import type { SavedQuery } from "@wireio/ql-shared"

import { listingLine, singleLine } from "../../utils/index.js"
import {
  applyConnectionArgs,
  applyOutputArgs,
  applyQueryInputArgs,
  QueryInputArgs,
  resolveOutputArgs,
  type ConnectionOptions,
  type OutputOptions,
  type QueryInputOptions
} from "../args/index.js"
import type { CliContext } from "../context/index.js"
import { OutputWriter } from "../output/index.js"
import { QLCli, type GlobalOptions } from "../QLCli.js"
import { requiredPositional, subcommandGroup } from "./commandUtils.js"
import { QLCommand, SavedSubcommand } from "./QLCommand.js"
import { QueryCommand } from "./QueryCommand.js"

/** Parsed flags of `wql saved …`. */
export interface SavedCommandArgs extends GlobalOptions, ConnectionOptions, QueryInputOptions, OutputOptions {
  /** Saved-query name (or id). */
  name?: string
}

/**
 * `wql saved list|save|run|remove` — the shared `saved-queries.json`.
 *
 * @param context - The run context.
 * @returns The yargs command module.
 */
export function createSavedCommand(context: CliContext): CommandModule<object, SavedCommandArgs> {
  return subcommandGroup<SavedCommandArgs>(QLCommand.saved, "list, save, run or remove saved queries", yargs =>
    yargs
      .command(
        SavedSubcommand.list,
        "list saved queries",
        identity,
        QLCli.handle(context, async () =>
          OutputWriter.writeLines(context.savedQueryStore.list().map(saved => SavedCommand.savedLine(saved)))
        )
      )
      .command(
        `${SavedSubcommand.save} <name> [query]`,
        "save a query (argument, --query-file, or stdin) under a name",
        (sub: Argv) => applyQueryInputArgs(requiredPositional(sub, "name")),
        QLCli.handle(context, async (argv: SavedCommandArgs) => {
          const saved = context.savedQueryStore.save(argv.name, await QueryInputArgs.readQueryText(argv, context.queryTextSource))
          OutputWriter.writeLines([SavedCommand.savedText(saved.name)])
        })
      )
      .command(
        `${SavedSubcommand.run} <name>`,
        "execute a saved query",
        (sub: Argv) => applyOutputArgs(applyConnectionArgs(requiredPositional(sub, "name"))),
        QLCli.handle(context, async (argv: SavedCommandArgs) => {
          const saved = context.savedQueryStore.assertSavedQuery(argv.name)
          context.exitCode = await QueryCommand.run(context, {
            query: saved.query,
            profile: context.resolveProfile(argv),
            output: resolveOutputArgs(argv)
          })
        })
      )
      .command(
        `${SavedSubcommand.remove} <name>`,
        "remove a saved query",
        (sub: Argv) => requiredPositional(sub, "name"),
        QLCli.handle(context, async (argv: SavedCommandArgs) => {
          context.savedQueryStore.remove(argv.name)
          OutputWriter.writeLines([SavedCommand.removedText(argv.name)])
        })
      )
  )
}

/** Saved command helpers. */
export namespace SavedCommand {
  /**
   * The confirmation of a saved query (`wql saved save`, the TUI's Alt+W).
   *
   * @param name - The saved query's name.
   * @returns The line.
   */
  export function savedText(name: string): string {
    return `saved ${name}`
  }

  /**
   * The confirmation of a removed saved query.
   *
   * @param name - The removed name (or id).
   * @returns The line.
   */
  export function removedText(name: string): string {
    return `removed ${name}`
  }

  /**
   * One listing line: `name<TAB>query (one line)`.
   *
   * @param saved - The saved query.
   * @returns The line.
   */
  export function savedLine(saved: SavedQuery): string {
    return listingLine([saved.name, singleLine(saved.query)])
  }
}
