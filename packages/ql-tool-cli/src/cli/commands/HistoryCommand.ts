import { identity } from "lodash"
import { match } from "ts-pattern"
import type { Argv, CommandModule } from "yargs"

import type { QueryHistoryEntry } from "@wireio/ql-shared"
import { QueryHistoryStore } from "@wireio/ql-shared/node"

import { ListingEmptyCell, listingLine, singleLine } from "../../utils/index.js"
import {
  applyConnectionArgs,
  applyOutputArgs,
  resolveOutputArgs,
  type ConnectionOptions,
  type OutputOptions
} from "../args/index.js"
import type { CliContext } from "../context/index.js"
import { QLUsageError } from "../exit/index.js"
import { OutputWriter } from "../output/index.js"
import { QLCli, type GlobalOptions } from "../QLCli.js"
import { requiredPositional, subcommandGroup } from "./commandUtils.js"
import { HistorySubcommand, QLCommand } from "./QLCommand.js"
import { QueryCommand } from "./QueryCommand.js"

/** Parsed flags of `wql history …`. */
export interface HistoryCommandArgs extends GlobalOptions, ConnectionOptions, OutputOptions {
  /** Entry id (rerun). */
  id?: string
  /** `--search`: query text filter (list). */
  search?: string
  /** `--count`: newest entries listed (list). */
  count?: number
}

/**
 * `wql history list|clear|rerun` — the shared `history.jsonl`.
 *
 * @param context - The run context.
 * @returns The yargs command module.
 */
export function createHistoryCommand(context: CliContext): CommandModule<object, HistoryCommandArgs> {
  return subcommandGroup<HistoryCommandArgs>(QLCommand.history, "list, clear or rerun executed queries", yargs =>
    yargs
      .command(
        HistorySubcommand.list,
        "list executed queries, newest first",
        (sub: Argv) =>
          sub
            .option("count", {
              type: "number",
              describe: `newest entries to list (default ${QueryHistoryStore.DefaultListLimit})`
            })
            .option("search", { type: "string", describe: "only queries containing this text" }),
        QLCli.handle(context, async (argv: HistoryCommandArgs) =>
          OutputWriter.writeLines(
            context.historyStore.list({ limit: argv.count, search: argv.search }).map(entry => HistoryCommand.entryLine(entry))
          )
        )
      )
      .command(
        HistorySubcommand.clear,
        "clear the history (an append racing the clear may survive)",
        identity,
        QLCli.handle(context, async () => {
          context.historyStore.clear()
          OutputWriter.writeLines([HistoryCommand.ClearedText])
        })
      )
      .command(
        `${HistorySubcommand.rerun} <id>`,
        "execute a history entry again (its profile unless --profile/--url is given)",
        (sub: Argv) => applyOutputArgs(applyConnectionArgs(requiredPositional(sub, "id"))),
        QLCli.handle(context, async (argv: HistoryCommandArgs) => {
          const entry = HistoryCommand.assertEntry(context, argv.id),
            profile = context.resolveProfile(HistoryCommand.connectionFor(context, entry, argv))
          context.exitCode = await QueryCommand.run(context, { query: entry.query, profile, output: resolveOutputArgs(argv) })
        })
      )
  )
}

/** History command helpers. */
export namespace HistoryCommand {
  /** The confirmation of a cleared history (`wql history clear`, the TUI's History route). */
  export const ClearedText = "history cleared"

  /**
   * One listing line: `executedAt<TAB>outcome<TAB>rows<TAB>id<TAB>profile<TAB>query`.
   *
   * @param entry - The record.
   * @returns The line.
   */
  export function entryLine(entry: QueryHistoryEntry): string {
    return listingLine([
      entry.executedAt,
      entry.errorKind ?? entry.outcome,
      entry.returnedRows ?? ListingEmptyCell,
      entry.id,
      entry.profile,
      singleLine(entry.query)
    ])
  }

  /**
   * The history entry with `id`.
   *
   * @param context - The run context.
   * @param id - The entry id.
   * @returns The entry.
   * @throws QLUsageError when no entry has that id.
   */
  export function assertEntry(context: CliContext, id: string): QueryHistoryEntry {
    const entry = context.historyStore.get(id)
    if (entry == null) throw new QLUsageError(`no history entry ${id}; list them with \`wql history list\``)
    return entry
  }

  /**
   * The connection flags of a rerun: the given flags, else the entry's profile
   * (a saved profile name, or the endpoint of an ad-hoc run).
   *
   * @param context - The run context.
   * @param entry - The entry being rerun.
   * @param argv - The parsed connection flags.
   * @returns Connection flags for `CliContext.resolveProfile`.
   */
  export function connectionFor(context: CliContext, entry: QueryHistoryEntry, argv: ConnectionOptions): ConnectionOptions {
    return match<ConnectionOptions, ConnectionOptions>(argv)
      .when(() => argv.profile != null || argv.url != null, () => argv)
      .when(() => context.profileStore.get(entry.profile) != null, () => ({ ...argv, profile: entry.profile }))
      .when(() => URL.canParse(entry.profile), () => ({ ...argv, url: entry.profile }))
      .otherwise(() => argv)
  }
}
