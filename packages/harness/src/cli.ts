#!/usr/bin/env node
/**
 * CLI entry point for the WIRE cluster manager.
 *
 * Usage:
 *   wire-test-cluster [global-options] <command> [command-options]
 *
 * Examples:
 *   wire-test-cluster --force --chain-dir=/data/opt/wire/chains/dev-001 create --build-dir build/claude -p 1
 *   wire-test-cluster --chain-dir=/data/opt/wire/chains/dev-001 run
 *   wire-test-cluster --chain-dir=/data/opt/wire/chains/dev-001 destroy
 */
import "source-map-support/register.js"
import Path from "path"
import Fs from "fs"
import Yargs from "yargs"
import { hideBin } from "yargs/helpers"
import ClusterManager, { type ClusterConfig } from "./cluster/ClusterManager"
import { log } from "./logger"
import { last } from "lodash"

const scriptName = last(process.argv[1].split("/")),
  cleanArgs = process.argv.slice(2).filter(arg => !arg.startsWith("--inspect")),
  parser = Yargs(cleanArgs)
    .scriptName(scriptName)
    .usage("$0 [global-options] <command> [command-options]")
    .option("chain-dir", {
      alias: "d",
      type: "string",
      demandOption: true,
      describe: "Directory for cluster data"
    })
    .option("force", {
      type: "boolean",
      default: false,
      describe: "Remove existing chain-dir before create"
    })
    .command("create", "Create and bootstrap a new cluster", y =>
      y
        .option("build-dir", {
          type: "string",
          demandOption: true,
          describe: "Path to wire-sysio build directory"
        })
        .option("pnodes", {
          alias: "p",
          type: "number",
          default: 1,
          describe: "Number of producer nodes"
        })
        .option("nodes", {
          alias: "n",
          type: "number",
          default: 0,
          describe: "Number of non-producer nodes"
        })
        .option("prod-count", {
          type: "number",
          default: 21,
          describe: "Number of producers to register"
        })
        .option("topology", {
          alias: "s",
          type: "string",
          default: "mesh",
          choices: ["mesh", "ring", "star"] as const,
          describe: "Network topology"
        })
        .option("http-secure", {
          type: "boolean",
          default: false,
          describe: "Use HTTPS for RPC endpoints"
        })
        .option("batch-operators", {
          alias: "b",
          type: "number",
          default: 1,
          describe: "Number of batch operator nodes"
        })
        .option("underwriters", {
          alias: "u",
          type: "number",
          default: 1,
          describe: "Number of underwriter nodes"
        })
    )
    .command("run", "Start an existing cluster from saved state")
    .command("destroy", "Stop and remove a cluster")
    .demandCommand(1, "A command is required: create, run, or destroy")
    .strict()
    .help()

async function main(): Promise<void> {
  const argv = await parser.parse()
  const command = argv._[0] as string
  const chainDir = Path.resolve(argv.chainDir as string)
  const force = argv.force as boolean

  log.info(`wire-test-cluster: command=${command} chain-dir=${chainDir}`)

  const manager = new ClusterManager()

  switch (command) {
    case "create": {
      const buildDir = Path.resolve(argv.buildDir as string)
      const pnodes = argv.pnodes as number
      const nodes = argv.nodes as number
      const prodCount = argv.prodCount as number
      const httpSecure = argv.httpSecure as boolean
      const batchOperators = argv.batchOperators as number
      const underwriters = argv.underwriters as number

      if (force && Fs.existsSync(chainDir)) {
        log.info(`wire-test-cluster: --force specified, removing ${chainDir}`)
        Fs.rmSync(chainDir, { recursive: true, force: true })
      }

      const config: ClusterConfig = {
        buildDir,
        chainDir,
        producerCount: prodCount,
        nodeCount: pnodes + nodes,
        httpSecure,
        batchOperatorCount: batchOperators,
        underwriterCount: underwriters
      }

      await manager.create(config)
      log.info("wire-test-cluster: cluster created successfully")
      break
    }

    case "run": {
      await manager.start()
      log.info("wire-test-cluster: cluster started, press Ctrl+C to stop")

      await new Promise<void>(resolve => {
        const shutdown = async () => {
          log.info("wire-test-cluster: shutting down...")
          await manager.stop()
          resolve()
        }
        process.on("SIGINT", () => void shutdown())
        process.on("SIGTERM", () => void shutdown())
      })
      break
    }

    case "destroy": {
      if (!Fs.existsSync(chainDir)) {
        console.error(`Error: chain-dir does not exist: ${chainDir}`)
        process.exit(1)
      }

      try {
        await manager.stop()
      } catch {
        // May not be running
      }

      Fs.rmSync(chainDir, { recursive: true, force: true })
      log.info(`wire-test-cluster: destroyed ${chainDir}`)
      break
    }
  }
}

main().catch(err => {
  console.error("wire-test-cluster fatal error:", err)
  process.exit(1)
})
