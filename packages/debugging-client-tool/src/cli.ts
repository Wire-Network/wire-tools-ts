#!/usr/bin/env node
import "source-map-support/register"
import Yargs from "yargs"
import { getLogger } from "@wireio/shared"
import { DebuggingServerClient } from "@wireio/debugging-client-shared"

import { handleList } from "./commands/list.js"
import { handleInspect } from "./commands/inspect.js"
import { handleTail } from "./commands/tail.js"
import { OutputFormat } from "./formatter.js"
import { pick } from "lodash"

const log = getLogger(__filename)

enum Command {
  list = "list",
  inspect = "inspect",
  tail = "tail"
}

/**
 * Run a command handler, logging any failure through the framework (never
 * `console.*`) before a non-zero exit. Data output already went through the
 * `stdout` logger inside the handler.
 */
async function run(handler: () => Promise<void>): Promise<void> {
  try {
    await handler()
  } catch (err) {
    log.error(`command failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

Yargs(process.argv.slice(2))
  .option("server", {
    type: "string",
    default: DebuggingServerClient.DefaultURL,
    describe: "Debugging server URL"
  })
  .option("format", {
    type: "string",
    choices: [OutputFormat.plain, OutputFormat.json],
    default: OutputFormat.plain,
    describe: "Output format"
  })
  .command(
    Command.list,
    "List stored envelopes",
    yargs =>
      yargs
        .option("epoch", {
          type: "number",
          describe: "Filter by single epoch index"
        })
        .option("epoch-start", {
          type: "number",
          describe: "Filter by epoch range start (inclusive)"
        })
        .option("epoch-end", {
          type: "number",
          describe: "Filter by epoch range end (inclusive)"
        })
        .option("endpoints", {
          type: "string",
          describe: "Filter by endpoints type name"
        })
        .option("start", {
          type: "string",
          describe: "Filter by start timestamp (ISO or unix ms)"
        })
        .option("end", {
          type: "string",
          describe: "Filter by end timestamp (ISO or unix ms)"
        }),
    async argv =>
      run(() =>
        handleList({
          server: argv.server,
          format: argv.format,
          epoch: argv.epoch,
          epochStart: argv.epochStart,
          epochEnd: argv.epochEnd,
          endpoints: argv.endpoints,
          start: argv.start,
          end: argv.end
        })
      )
  )
  .command(
    Command.inspect,
    "Inspect a specific envelope by storage key",
    yargs =>
      yargs.option("key", {
        type: "string",
        demandOption: true,
        describe: "Storage key (from list output)"
      }),
    async argv => run(() => handleInspect(pick(argv, "server", "format", "key")))
  )
  .command(
    Command.tail,
    "Watch for new envelopes in real-time",
    yargs =>
      yargs
        .option("poll-ms", {
          type: "number",
          default: 2_000,
          describe: "Poll interval in ms"
        })
        .option("endpoints", {
          type: "string",
          describe: "Filter by endpoints type name"
        }),
    async argv =>
      run(() => handleTail(pick(argv, "server", "format", "pollMs", "endpoints")))
  )
  .demandCommand(1)
  .strict()
  .parse()
