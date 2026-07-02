import "source-map-support/register.js"
import Path from "node:path"
import Yargs from "yargs"
import { ClusterManager } from "../cluster/ClusterManager.js"
import { ClusterConfig } from "../config/ClusterConfig.js"
import { getLogger } from "../logging/Logger.js"
import {
  applyClusterBuildOptionsArgs,
  toClusterBuildOptions
} from "./ClusterBuildOptionsArgs.js"

const log = getLogger(__filename)

/**
 * The `wire-test-cluster` CLI (orchestration-engine path): `create` bootstraps a
 * cluster via {@link ClusterManager} from the shared
 * {@link applyClusterBuildOptionsArgs} flag surface (the SAME every `flow-*`
 * uses — one implementation, no CLI/flow duplication); `destroy` tears it down.
 * Exit code reflects the bootstrap {@link Report}'s success.
 */
export function main(argv: string[] = process.argv.slice(2)): Promise<unknown> {
  return Yargs(argv.filter(arg => !arg.startsWith("--inspect")))
    .scriptName("wire-test-cluster")
    .command(
      "create",
      "Create + bootstrap a new cluster",
      builder => applyClusterBuildOptionsArgs(builder),
      async args => {
        const report = await ClusterManager.create(toClusterBuildOptions(args))
        log.info(
          `[cluster] bootstrap ${report.succeeded ? "SUCCEEDED" : "FAILED"}`
        )
        process.exit(report.succeeded ? 0 : 1)
      }
    )
    .command(
      "destroy",
      "Stop + delete a cluster",
      builder =>
        builder.option("cluster-path", {
          alias: "d",
          type: "string",
          demandOption: true,
          describe: "cluster data directory"
        }),
      async args => {
        const config = ClusterConfig.loadSync(
          Path.join(
            Path.resolve(args.clusterPath),
            ClusterConfig.ConfigFilename
          )
        )
        await ClusterManager.destroy(config)
        process.exit(0)
      }
    )
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync()
}

void main()
