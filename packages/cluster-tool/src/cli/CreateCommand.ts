import type { Argv } from "yargs"
import { ClusterManager } from "../cluster/ClusterManager.js"
import { getLogger } from "../logging/Logger.js"
import {
  applyClusterBuildOptionsArgs,
  toClusterBuildOptions
} from "./ClusterBuildOptionsArgs.js"
import { ClusterCommand } from "./ClusterCommand.js"

const log = getLogger(__filename)

/**
 * The `create` command: bootstrap a brand-new cluster from the shared
 * {@link applyClusterBuildOptionsArgs} flag surface — the SAME surface every
 * `flow-*` executable uses (one implementation, no CLI/flow duplication). The
 * process exit code mirrors the bootstrap {@link Report}'s success.
 *
 * @returns The yargs command module for `create`.
 */
export function createCreateCommand() {
  return {
    command: ClusterCommand.create,
    describe: "Create + bootstrap a new cluster",
    builder: (builder: Argv) => applyClusterBuildOptionsArgs(builder),
    handler: async (args: Record<string, unknown>) => {
      const report = await ClusterManager.create(toClusterBuildOptions(args))
      log.info(
        `[cluster] bootstrap ${report.succeeded ? "SUCCEEDED" : "FAILED"}`
      )
      process.exit(report.succeeded ? 0 : 1)
    }
  }
}
