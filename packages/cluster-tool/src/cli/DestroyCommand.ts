import Path from "node:path"
import type { Argv } from "yargs"
import { ClusterManager } from "../cluster/ClusterManager.js"
import { ClusterConfig } from "../config/ClusterConfig.js"
import { applyClusterPathArgs, type ClusterPathArgv } from "./ClusterPathArgs.js"
import { ClusterCommand } from "./ClusterCommand.js"

/**
 * The `destroy` command: stop every daemon of an existing cluster and delete
 * its data directory. Exits `0` unconditionally once teardown completes.
 *
 * @returns The yargs command module for `destroy`.
 */
export function createDestroyCommand() {
  return {
    command: ClusterCommand.destroy,
    describe: "Stop + delete a cluster",
    builder: (builder: Argv) => applyClusterPathArgs(builder),
    handler: async (args: ClusterPathArgv) => {
      const config = ClusterConfig.loadSync(
        Path.join(Path.resolve(args.clusterPath), ClusterConfig.ConfigFilename)
      )
      await ClusterManager.destroy(config)
      process.exit(0)
    }
  }
}
