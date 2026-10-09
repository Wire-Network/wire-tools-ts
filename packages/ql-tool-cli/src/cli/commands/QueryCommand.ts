import { Either } from "@3fv/prelude-ts"
import { match } from "ts-pattern"
import type { Argv, CommandModule } from "yargs"

import {
  OutputFormat,
  PageSizeMode,
  QueryExecutionStatus,
  QueryFailureKind,
  QueryHistoryEntry,
  ResultRenderer,
  ResultSummary,
  ResultView,
  type ConnectionProfile,
  type QueryExecutionSuccess
} from "@wireio/ql-shared"
import { getLogger } from "@wireio/shared"

import { NoLimitText, recordHistory } from "../../utils/index.js"
import {
  applyConnectionArgs,
  applyOutputArgs,
  applyQueryInputArgs,
  OutputArgs,
  OutputWindowSource,
  QueryInputArgs,
  resolveOutputArgs,
  type ConnectionOptions,
  type OutputConfig,
  type OutputOptions,
  type QueryInputOptions
} from "../args/index.js"
import type { CliContext } from "../context/index.js"
import { QLExitCode, QLUsageError } from "../exit/index.js"
import { ErrorPrinter, OutputWriter } from "../output/index.js"
import { QLCli, type GlobalOptions } from "../QLCli.js"
import { QLCommand } from "./QLCommand.js"

const log = getLogger(__filename)

/** Parsed flags of `wql [query]`. */
export interface QueryCommandArgs extends GlobalOptions, ConnectionOptions, QueryInputOptions, OutputOptions {}

/** One query run: the text, where it goes, and how its output looks (shared by query / saved run / history rerun). */
export interface QueryRunRequest {
  /** The SQL text. */
  query: string
  /** The resolved connection. */
  profile: ConnectionProfile
  /** The resolved output configuration. */
  output: OutputConfig
}

/** Formats that carry the human page footer. */
const FooterFormats: readonly OutputFormat[] = [OutputFormat.table, OutputFormat.markdown] as const

/**
 * `wql [query]` — the default command (`$0`): execute one SELECT and print one
 * server page in the chosen format.
 *
 * @param context - The run context.
 * @returns The yargs command module.
 */
export function createQueryCommand(context: CliContext): CommandModule<object, QueryCommandArgs> {
  return {
    command: [`$0 [query]`, `${QLCommand.query} [query]`],
    describe: "execute a SELECT against a node's query engine and print one server page",
    builder: (yargs: Argv) =>
      applyOutputArgs(applyConnectionArgs(applyQueryInputArgs(yargs))) as unknown as Argv<QueryCommandArgs>,
    handler: QLCli.handle(context, argv => runQueryCommand(context, argv))
  }
}

/**
 * Handler body of `wql [query]`.
 *
 * @param context - The run context.
 * @param argv - The parsed flags.
 */
export async function runQueryCommand(context: CliContext, argv: QueryCommandArgs): Promise<void> {
  const query = await QueryInputArgs.readQueryText(argv, context.queryTextSource),
    profile = context.resolveProfile(argv),
    output = resolveOutputArgs(argv)
  context.exitCode = await QueryCommand.run(context, { query, profile, output })
}

/** The query runner shared by `query`, `saved run` and `history rerun`. */
export namespace QueryCommand {
  /**
   * Execute, render (or report the failure), record history, and return the exit code.
   *
   * @param context - The run context.
   * @param request - Query, connection and output.
   * @returns The exit code of the run.
   */
  export async function run(context: CliContext, request: QueryRunRequest): Promise<QLExitCode> {
    const { query, profile, output } = request,
      client = context.createClient(profile)
    log.debug(
      `query window offset=${output.window.offset} limit=${output.window.limit ?? NoLimitText} format=${output.format} profile=${profile.name}`
    )
    const { value: execution, interrupted } = await QLCli.runInterruptibly(signal =>
      client.execute(query, { ...output.window, signal })
    )
    recordHistory(context.historyStore, QueryHistoryEntry.of(execution, profile.name, new Date()))
    return match(execution)
      .with({ status: QueryExecutionStatus.success }, success => {
        printSuccess(success, output)
        return QLExitCode.success
      })
      .with({ status: QueryExecutionStatus.failure }, failed => {
        ErrorPrinter.printFailure(failed.failure, query)
        return interrupted && failed.failure.kind === QueryFailureKind.cancelled
          ? QLExitCode.interrupted
          : QLExitCode.forFailure(failed.failure)
      })
      .exhaustive()
  }

  /**
   * The stderr hint naming the next window when the server reports more rows:
   * `--page N+1` for pager windows, `--offset X` for explicit (or all-mode) windows.
   *
   * @param execution - The successful execution.
   * @param output - The resolved output.
   * @returns The hint, or undefined when no more rows exist.
   */
  export function nextPageHint(execution: QueryExecutionSuccess, output: OutputConfig): string {
    const { page } = execution.result
    if (!page.has_more) return undefined
    return output.windowSource === OutputWindowSource.pager && output.pager.mode === PageSizeMode.paged
      ? `more rows: --page ${output.pager.page + 1}`
      : `more rows: --offset ${Number(page.offset) + Number(page.returned_rows)}`
  }

  /** Render the page (client view over the loaded rows) and write it; footer + hints for humans. */
  function printSuccess(execution: QueryExecutionSuccess, output: OutputConfig): void {
    const view = createView(execution, output),
      rendered = ResultRenderer.render(
        output.format,
        { execution, view, range: view.fullRange() },
        OutputArgs.renderOptions(output)
      ),
      footer = FooterFormats.includes(output.format) ? `\n${ResultSummary.describe(execution.result, output.window.limit)}\n` : ""
    OutputWriter.write(`${rendered}${footer}`, output.outputFile)
    const hint = nextPageHint(execution, output)
    if (hint != null) ErrorPrinter.printHint(hint)
  }

  /** The client view; an unknown column named by --columns/--sort/--filter is a usage problem. */
  function createView(execution: QueryExecutionSuccess, output: OutputConfig): ResultView {
    return Either.try(() => ResultView.create(execution.result, OutputArgs.viewOptions(output)))
      .ifLeft(error => {
        throw new QLUsageError("cannot apply --columns/--sort/--filter to this result", { cause: error })
      })
      .getOrThrow()
  }
}
