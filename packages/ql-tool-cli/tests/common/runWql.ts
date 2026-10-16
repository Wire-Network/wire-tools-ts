import { getLoggingManager, Level } from "@wireio/shared"

import { createQLParser, QLCli, type CliContext } from "@wireio/ql-tool-cli/cli/index.js"

import { captureLogs } from "./logCapture.js"

/** The outcome of one in-process wql run. */
export interface WqlRun {
  /** Exit code. */
  exitCode: number
  /** stdout channel records. */
  stdout: string[]
  /** stderr channel records. */
  stderr: string[]
}

/**
 * Run wql in-process (the real parser and handlers) with captured output.
 *
 * @param args - Arguments.
 * @param context - The run context.
 * @returns Exit code and output.
 */
export async function runWql(args: string[], context: CliContext): Promise<WqlRun> {
  const logs = captureLogs()
  try {
    await QLCli.completeParse(context, () => createQLParser(args, context).parseAsync())
    return { exitCode: context.exitCode, stdout: logs.stdout(), stderr: logs.stderr() }
  } finally {
    logs.restore()
    getLoggingManager().setRootLevel(Level.info)
  }
}
