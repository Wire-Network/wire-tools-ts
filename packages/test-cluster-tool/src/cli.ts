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

import { ClusterManager, type ClusterConfig } from "./cluster/ClusterManager.js"
import { ClusterPorts } from "./cluster/ClusterPorts.js"
import { log } from "./logger.js"
import { identity, last } from "lodash"
import * as Assert from "node:assert"
import { ProcessManager } from "./processes/ProcessManager.js"
import { ProcessSignalName } from "./processes/ProcessSignals.js"
import { inRange, isNotEmpty, mkdirs } from "./util.js"
import { asOption, Future } from "@3fv/prelude-ts"
import { isPromise } from "@wireio/shared"
import { ClusterFiles } from "@wireio/debugging-shared"
import { UnderwriterTools } from "./tools/underwriter/index.js"
import {
  readClusterConfigFile,
  writeClusterConfigFile
} from "./cluster/ClusterConfigPersistence.js"

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

  return (clusterManager = new ClusterManager(config))
}

/**
 * Load cluster configuration from file
 */
function loadClusterConfig(): ClusterConfig {
  const { configFile } = GlobalArgs
  Assert.ok(
    isNotEmpty(configFile),
    `Config file path is required: ${configFile}`
  )
  log.info(`wire-test-cluster: loading config from ${configFile}`)
  Assert.ok(Fs.existsSync(configFile), `config file not found: ${configFile}`)
  return readClusterConfigFile(configFile)
}

/**
 * SIGNAL HANDLER
 */
const shutdown = async () => {
  log.info("wire-test-cluster: shutting down...")
  await clusterManager?.stop()
}
process.on(ProcessSignalName.SIGINT, () => void shutdown())
process.on(ProcessSignalName.SIGTERM, () => void shutdown())

async function main(): Promise<void> {
  try {
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
          const configFile = Path.join(clusterPath, ClusterFiles.ConfigFilename)
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
              .option("batch-operator-count", {
                alias: ["b", "batch-operators"],
                type: "number",
                default: 3,
                describe: "Number of batch operator nodes (3–21)"
              })
              .option("underwriter-count", {
                alias: ["u", "underwriters"],
                type: "number",
                default: 1,
                describe: "Number of underwriter nodes (1–100)"
              })
              .option("epoch-duration-sec", {
                alias: ["epoch-duration"],
                type: "number",
                default: 60,
                describe:
                  "Epoch duration in seconds (depot floor is 60 — sysio.epoch::setconfig rejects lower)"
              })
              .option("warmup-epochs", {
                type: "number",
                default: 1,
                describe:
                  "Epochs before an operator transitions from WARMUP to ACTIVE"
              })
              .option("cooldown-epochs", {
                type: "number",
                default: 1,
                describe:
                  "Epochs before an operator can deregister after entering COOLDOWN"
              })
              .option("ethereum-path", {
                type: "string",
                demandOption: true,
                describe:
                  "Path to wire-ethereum repo root. anvil is bootstrapped with the outpost contract deployment."
              })
              .option("solana-path", {
                type: "string",
                demandOption: true,
                describe:
                  "Path to wire-solana repo root. solana-test-validator is bootstrapped with the opp-outpost program."
              })
              .option("underwriter-collateral-json-file", {
                type: "string",
                describe:
                  "Path to a JSON file specifying per-underwriter collateral deposits. " +
                  "Two shapes accepted (parsed via the `ChainTokenAmount` proto model): " +
                  "(uniform) `Array<ChainTokenAmount>` applied to every underwriter, or " +
                  "(varied) `Array<Array<ChainTokenAmount>>` with outer length === --underwriters. " +
                  "Omit for defaults (1000 base units of WIRE/ETH/SOL per underwriter)."
              })
              .check(argv => {
                Assert.ok(
                  inRange(argv["batch-operator-count"], 3, 21),
                  "--batch-operators must be between 3 and 21"
                )

                Assert.ok(
                  inRange(argv["underwriter-count"], 1, 100),
                  "--underwriters must be between 1 and 100"
                )

                Assert.ok(
                  inRange(argv["epoch-duration-sec"], 60),
                  "--epoch-duration must be at least 60"
                )
                return true
              }),
          async argv => {
            const { clusterPath, force, configFile } = GlobalArgs,
              buildPath = Path.resolve(argv.buildPath as string),
              {
                pnodes,
                nodes,
                prodCount,
                httpSecure,
                batchOperatorCount,
                underwriterCount,
                epochDurationSec,
                warmupEpochs,
                cooldownEpochs
              } = argv

            asOption(Fs.existsSync(clusterPath)).ifSome(() => {
              Assert.ok(
                force,
                `wire-test-cluster: --force required to overwrite existing directory ${clusterPath}`
              )
              log.info(
                `wire-test-cluster: --force specified, removing ${clusterPath}`
              )
              Fs.rmSync(clusterPath, { recursive: true, force: true })
            })

            mkdirs(clusterPath)

            // CREATE THE CONFIG
            const ethereumPath = Path.resolve(argv.ethereumPath),
              solanaPath = Path.resolve(argv.solanaPath),
              nodeCount = pnodes + nodes,
              ports = await ClusterPorts.resolve({
                nodeCount,
                batchOperatorCount,
                underwriterCount
              }),
              config: ClusterConfig = {
                buildPath,
                clusterPath,
                dataPath: mkdirs(
                  Path.join(clusterPath, ClusterManager.DataSubpath)
                ),
                walletPath: mkdirs(
                  Path.join(clusterPath, ClusterManager.WalletSubpath)
                ),
                producerCount: prodCount,
                nodeCount,
                httpSecure,
                batchOperatorCount,
                underwriterCount,
                ethereumPath,
                solanaPath,
                epochDurationSec,
                warmupEpochs,
                cooldownEpochs,
                underwriterCollateral: UnderwriterTools.Collateral.load(
                  argv.underwriterCollateralJsonFile as string | undefined,
                  underwriterCount
                ),
                ports,
                executables: await ClusterManager.resolveExePaths(buildPath)
              }

            log.info(`wire-test-cluster: writing config to ${configFile}`)
            writeClusterConfigFile(configFile, config)

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
            const config = loadClusterConfig()
            await ClusterPorts.verifyAvailable(config.ports)
            await createClusterManager(config).loadState().startAndWait()
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
              log.error(`Error: chain-dir does not exist: ${clusterPath}`)
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
  } catch (err) {
    log.error("wire-test-cluster fatal error:", err)
    process.exit(1)
  }
}

main().catch(err => {
  log.error("wire-test-cluster fatal error:", err)
  process.exit(1)
})
