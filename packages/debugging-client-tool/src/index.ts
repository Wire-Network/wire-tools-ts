#!/usr/bin/env node
import "source-map-support/register"
import Yargs from "yargs"
import { DebuggingServerClient } from "@wire-e2e-tests/debugging-client-shared"

import { handleList } from "./commands/list"
import { handleInspect } from "./commands/inspect"
import { handleTail } from "./commands/tail"
import { OutputFormat } from "./formatter"
import { pick } from "lodash"

enum Command {
  list = "list",
  inspect = "inspect",
  tail = "tail"
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
    async argv => {
      await handleList({
        server: argv.server,
        format: argv.format,
        epoch: argv.epoch,
        epochStart: argv.epochStart,
        epochEnd: argv.epochEnd,
        endpoints: argv.endpoints,
        start: argv.start,
        end: argv.end
      })
    }
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
    async argv => {
      await handleInspect(pick(argv, "server", "format", "key"))
    }
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
    async argv => {
      await handleTail(pick(argv, "server", "format", "pollMs", "endpoints"))
    }
  )
  .demandCommand(1)
  .strict()
  .parse()
