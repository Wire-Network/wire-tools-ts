import Yargs, { type Argv } from "yargs"

import { QLBrand } from "@wireio/ql-shared"
import { getLoggingManager, Level } from "@wireio/shared"

import {
  createHistoryCommand,
  createProfilesCommand,
  createQueryCommand,
  createSavedCommand,
  createSchemaCommand,
  createTuiCommand
} from "./commands/index.js"
import { CliContext } from "./context/index.js"
import { QLCli, type GlobalOptions } from "./QLCli.js"

/**
 * Assemble the wql parser over `argv` (yargs routes; this only registers the
 * commands, the global `--log-level`, and the fail handler).
 *
 * @param argv - The arguments (without node + script).
 * @param context - The run context (stores, connection resolver, exit code).
 * @returns The parser; `parseAsync()` runs the routed command.
 */
export function createQLParser(argv: string[], context: CliContext): Argv<GlobalOptions> {
  return Yargs(argv)
    .scriptName(QLBrand.CliName)
    // Repeatable array flags take ONE value per occurrence (`--sort a --sort b`),
    // so a flag never swallows the positional query that follows it.
    .parserConfiguration({ "greedy-arrays": false })
    .option("log-level", {
      choices: Object.values(Level),
      describe: `diagnostic log level on stderr (default ${QLCli.DefaultLogLevel})`
    })
    .middleware((parsed: GlobalOptions) => {
      getLoggingManager().setRootLevel(parsed.logLevel ?? QLCli.DefaultLogLevel)
    })
    .command(createQueryCommand(context))
    .command(createTuiCommand(context))
    .command(createSchemaCommand(context))
    .command(createProfilesCommand(context))
    .command(createHistoryCommand(context))
    .command(createSavedCommand(context))
    .strict()
    .help()
    .version()
    .exitProcess(false)
    .fail(QLCli.createFailHandler(context)) as unknown as Argv<GlobalOptions>
}

/**
 * Parse `argv`, run the routed wql command, and set the process exit code. Touches
 * no process-wide hook (logging appenders, source maps) — `main` installs those.
 *
 * @param argv - The arguments (default: the process's, without node + script).
 * @param context - The run context (default: real stores, process env and stdin).
 */
export async function executeCommandLine(argv: string[] = process.argv.slice(2), context: CliContext = new CliContext()): Promise<void> {
  await QLCli.completeParse(context, () => createQLParser(argv, context).parseAsync())
  process.exitCode = context.exitCode
}
