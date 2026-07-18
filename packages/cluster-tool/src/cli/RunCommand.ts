import Path from "node:path"
import { PidSources } from "@wireio/debugging-shared"
import type { Argv } from "yargs"
import { ClusterKeepAlive } from "../cluster/ClusterKeepAlive.js"
import { ClusterManager } from "../cluster/ClusterManager.js"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import { getLogger } from "../logging/Logger.js"
import {
  applyClusterPathArgs,
  type ClusterPathArgv
} from "./ClusterPathArgs.js"
import { ClusterCommand } from "./ClusterCommand.js"

const log = getLogger(__filename)

/**
 * The `run` command's help text. Spelled out explicitly because `run` supports
 * ONLY clusters produced by `wire-cluster-tool create` — a flow's own
 * ephemeral cluster is never persisted (`cluster-state.json` /
 * `cluster-keys.json` are written solely by `create`), so a flow-run cluster
 * directory has nothing for `run` to reload and is never resumable.
 */
const Describe =
  "Start an existing cluster from saved state (clusters produced by " +
  "`wire-cluster-tool create` only — flow-run clusters are not resumable)"

/**
 * The `run` command: reload an existing, previously-`create`d cluster's
 * config and start every daemon from saved state. {@link ClusterManager.run}
 * resolves once every daemon is up and one epoch advance is confirmed
 * (protocol liveness); a failure there throws, propagating as a rejected
 * command handler promise (non-zero process exit — no {@link Report} is
 * produced by `run`). On success the CLI logs the cluster's log directory and
 * parks on a {@link ClusterKeepAlive} until Ctrl+C, which flows through
 * `ProcessManager`'s own SIGINT teardown.
 *
 * @returns The yargs command module for `run`.
 */
export function createRunCommand() {
  return {
    command: ClusterCommand.run,
    describe: Describe,
    builder: (builder: Argv) => applyClusterPathArgs(builder),
    handler: async (args: ClusterPathArgv) => {
      const clusterPath = Path.resolve(args.clusterPath)
      const config = ClusterConfigProvider.loadSync(
        Path.join(clusterPath, ClusterConfigProvider.ConfigFilename)
      )
      await ClusterManager.run(config)
      log.info(
        `[cluster] running — logs: ${Path.join(clusterPath, PidSources.LogsSubdir)} — Ctrl+C for graceful shutdown`
      )
      await ClusterKeepAlive.create().wait()
    }
  }
}
