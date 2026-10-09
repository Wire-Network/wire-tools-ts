// The bundle entry: importing it only DEFINES `main` — the process hooks (the
// routing appender, source maps) install when `main` starts, and `main` is never
// self-invoked (bin/wql and bin/wire-ql-tui call it with their argv).
import SourceMapSupport from "source-map-support"

import { StdStreamAppender } from "../logger.js"
import { CliContext } from "./context/index.js"
import { executeCommandLine } from "./QLParser.js"

export * from "./args/index.js"
export * from "./commands/index.js"
export * from "./context/index.js"
export * from "./exit/index.js"
export * from "./output/index.js"
export * from "./QLCli.js"
export * from "./QLParser.js"

/**
 * The wql process entry: install source-mapped stack traces and the routing
 * appender ({@link StdStreamAppender}) FIRST, then run the command line
 * ({@link executeCommandLine}) and apply its exit code to the process.
 *
 * @param argv - The arguments (default: the process's, without node + script).
 * @param context - The run context (default: real stores, process env and stdin).
 */
export async function main(argv: string[] = process.argv.slice(2), context: CliContext = new CliContext()): Promise<void> {
  SourceMapSupport.install()
  StdStreamAppender.install()
  await executeCommandLine(argv, context)
}
