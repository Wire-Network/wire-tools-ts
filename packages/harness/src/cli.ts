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
import { identity, last } from "lodash"
import { match } from "ts-pattern"
import * as Assert from "node:assert"
import { ProcessManager } from "./processes/ProcessManager"
import { isNotEmpty, mkdirs } from "./util"
import { Future } from "@3fv/prelude-ts"
import { isPromise } from "@wireio/shared"

const GlobalArgs = {
  clusterPath: "",
  configFile: "",
  force: false
}

enum ClusterCommand {
  create = "create",
  run = "run",
  destroy = "destroy"
}

// Ref to cluster manager
let clusterManager: ClusterManager

/**
 * Get the cluster manager instance
 *
 * @param config
 */
function createClusterManager(config: ClusterConfig): ClusterManager {
  Assert.ok(!clusterManager, "Cluster manager already exists")
  Assert.ok(config, "Cluster config is required")

  clusterManager = new ClusterManager(config)
  return clusterManager
}

function loadClusterConfig(): ClusterConfig {
  const { configFile } = GlobalArgs
  Assert.ok(
    isNotEmpty(configFile),
    `Config file path is required: ${configFile}`
  )
  log.info(`wire-test-cluster: loading config from ${configFile}`)
  Assert.ok(Fs.existsSync(configFile), `config file not found: ${configFile}`)
  return JSON.parse(Fs.readFileSync(configFile, "utf-8"))
}

/**
 * SIGNAL HANDLER
 */
const shutdown = async () => {
  log.info("wire-test-cluster: shutting down...")
  await clusterManager?.stop()
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())

async function main(): Promise<void> {
  // CREATE ARG PARSER & COMMAND HANDLERS
  const scriptName = last(process.argv[1].split("/")),
    cleanArgs = process.argv
      .slice(2)
      .filter(arg => !arg.startsWith("--inspect")),
    result = Yargs(cleanArgs)
      .scriptName(scriptName)
      .usage("$0 [global-options] <command> [command-options]")
      .option("cluster-path", {
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
      .middleware(({ clusterPath, force }) => {
        const configFile = Path.join(clusterPath, "cluster-config.json")
        Object.assign(GlobalArgs, { clusterPath, configFile, force })

        ProcessManager.setClusterPath(clusterPath)
      })
      .command(
        ClusterCommand.create,
        "Create and bootstrap a new cluster",
        builder =>
          builder
            .option("build-path", {
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
            .option("ethereum-path", {
              type: "string",
              describe:
                "Path to wire-ethereum repo root. If provided, anvil is bootstrapped with contract deployment."
            }),
        async argv => {
          const { clusterPath, force, configFile } = GlobalArgs,
            buildPath = Path.resolve(argv.buildPath as string),
            {
              pnodes,
              nodes,
              prodCount,
              httpSecure,
              batchOperators,
              underwriters
            } = argv

          if (Fs.existsSync(clusterPath)) {
            Assert.ok(
              force,
              `wire-test-cluster: --force required to overwrite existing directory ${clusterPath}`
            )
            log.info(
              `wire-test-cluster: --force specified, removing ${clusterPath}`
            )
            Fs.rmSync(clusterPath, { recursive: true, force: true })
          }

          mkdirs(clusterPath)

          // CREATE THE CONFIG
          const ethereumPath = (argv.ethereumPath as string | undefined)
            ? Path.resolve(argv.ethereumPath as string)
            : undefined

          const config: ClusterConfig = {
            buildPath,
            clusterPath,
            dataPath: mkdirs(Path.join(clusterPath, "data")),
            walletPath: mkdirs(Path.join(clusterPath, "wallet")),
            producerCount: prodCount,
            nodeCount: pnodes + nodes,
            httpSecure,
            batchOperatorCount: batchOperators,
            underwriterCount: underwriters,
            ethereumPath,
            executables: await ClusterManager.resolveExePaths(buildPath)
          }
          log.info(`wire-test-cluster: writing config to ${configFile}`)
          Fs.writeFileSync(configFile, JSON.stringify(config, null, 2))

          await createClusterManager(config).create()

          log.info("wire-test-cluster: cluster created successfully")
          process.exit(0)
        }
      )
      .command(
        ClusterCommand.run,
        "Start an existing cluster from saved state",
        identity,
        async _argv => {
          // THIS WILL START THE CLUSTER & WAIT ON A STOP SIGNAL
          // BEFORE RETURNING.
          await createClusterManager(loadClusterConfig())
            .loadState()
            .startAndWait()
        }
      )
      .command(
        ClusterCommand.destroy,
        "Stop and remove a cluster",
        identity,
        async _argv => {
          const { clusterPath } = GlobalArgs,
            manager = createClusterManager(loadClusterConfig()).loadState()

          if (!Fs.existsSync(clusterPath)) {
            console.error(`Error: chain-dir does not exist: ${clusterPath}`)
            process.exit(1)
          }

          try {
            await manager.stop()
          } catch (err) {
            log.error(`wire-test-cluster: failed to stop cluster: ${err}`)
          }

          Fs.rmSync(clusterPath, { recursive: true, force: true })
          log.info(`wire-test-cluster: destroyed ${clusterPath}`)
        }
      )
      .demandCommand(1, "A command is required: create, run, or destroy")
      .strict()
      .help()
      .parse()

  // IF A PROMISE WAS RETURNED, AWAIT IT
  await (isPromise(result) ? result : Promise.resolve(result))
}

main().catch(err => {
  console.error("wire-test-cluster fatal error:", err)
  process.exit(1)
})
