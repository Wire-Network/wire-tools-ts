#!/usr/bin/env node
import "source-map-support/register"

import Yargs from "yargs"

import { DebuggingServer } from "./DebuggingServer.js"
import { getLogger } from "@wireio/shared"

enum Command {
  start = "start"
}
const log = getLogger("wire-debugging-server")

Yargs(process.argv.slice(2))
  .command(
    Command.start,
    "Start the debugging tool server",
    yargs =>
      yargs
        .option("port", {
          type: "number",
          default: DebuggingServer.DefaultPort,
          describe: "Server port"
        })
        .option("host", {
          type: "string",
          default: DebuggingServer.DefaultHost,
          describe: "Server bind address"
        })
        .option("cluster-path", {
          type: "string",
          demandOption: true,
          describe:
            "Cluster directory (required, no default). OPP envelopes resolve to <cluster-path>/data/opp-debugging."
        }),
    async argv => {
      const server = await DebuggingServer.create({
        port: argv.port,
        host: argv.host,
        clusterPath: argv.clusterPath
      })
      const addr = await server.start()
      log.info(`Debugging server listening on ${addr.address}:${addr.port}`)
    }
  )
  .demandCommand(1)
  .strict()
  .parse()

export {}
