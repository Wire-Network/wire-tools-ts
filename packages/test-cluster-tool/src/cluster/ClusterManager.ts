import Fs from "node:fs"
import Path from "node:path"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import { ClusterConfig } from "../config/ClusterConfig.js"
import { NodeConfig } from "../config/NodeConfig.js"
import { getLogger } from "../logging/Logger.js"
import type { ClusterBuild } from "../orchestration/ClusterBuild.js"
import type { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"
import { ClusterBuildDefaults } from "../orchestration/ClusterBuildDefaults.js"
import type { Report } from "../report/Report.js"
import { mkdirs } from "../utils/fsUtils.js"
import { ProcessManager } from "./processes/ProcessManager.js"

const log = getLogger(__filename)

/**
 * Slim cluster lifecycle: resolve config → lay down the filesystem (dirs, the
 * shared `genesis.json`, per-node `config.ini` / `logging.json`) → run the
 * {@link ClusterBuildDefaults} bootstrap → persist `cluster-config.json`. The
 * heavy orchestration lives in the build; this only owns the filesystem + the
 * process-manager cluster path + teardown.
 */
export namespace ClusterManager {
  /** Per-node nodeop config filename. */
  const NodeConfigFilename = "config.ini"
  /** Per-node nodeop logging config filename. */
  const NodeLoggingFilename = "logging.json"

  /**
   * Create + bootstrap a cluster: resolve `options`, write the cluster files,
   * run the default build, persist the resolved config, and return its
   * {@link Report}. The process manager's cluster path is set here so every
   * `Steps.processes.*` step can get-or-create against it.
   */
  export async function create(options: ClusterBuildOptions): Promise<Report> {
    return launch(await ClusterBuildDefaults.create(options))
  }

  /**
   * Lay down the filesystem + persist config for an ALREADY-COMPOSED build, then
   * run it → {@link Report}. Shared by {@link create} (default bootstrap only)
   * and `FlowCLI` (default bootstrap + the flow's scenario phases already pushed
   * onto `build`). The process-manager cluster path is set here so every
   * `Steps.processes.*` step can get-or-create against it.
   *
   * @param build - The composed cluster build (bootstrap ± scenario phases).
   * @returns The run's report.
   */
  export async function launch<C extends ClusterBuildContext = ClusterBuildContext>(
    build: ClusterBuild<C>
  ): Promise<Report> {
    const config = build.config
    ProcessManager.setClusterPath(config.clusterPath)
    writeClusterFiles(config)
    await config.save()
    log.info(`[cluster] filesystem ready at ${config.clusterPath}; running build`)
    return build.build()
  }

  /** Write dirs, the shared genesis, and per-node config/logging from the plan. */
  function writeClusterFiles(config: ClusterConfig): void {
    mkdirs(config.dataPath)
    mkdirs(config.walletPath)
    mkdirs(config.report.path)
    Fs.writeFileSync(config.genesisFile, config.genesis.render())
    NodeConfig.plan(config).forEach(node => {
      mkdirs(node.nodePath)
      Fs.writeFileSync(Path.join(node.nodePath, NodeConfigFilename), node.ini.render())
      Fs.writeFileSync(Path.join(node.nodePath, NodeLoggingFilename), node.logging.render())
    })
  }

  /** Stop every managed process (graceful, or force-kill when `forceKill`). */
  export async function stop(forceKill = false): Promise<void> {
    await ProcessManager.get().stopAll(forceKill)
  }

  /** Stop everything + remove the cluster directory. */
  export async function destroy(config: ClusterConfig): Promise<void> {
    await stop(true)
    Fs.rmSync(config.clusterPath, { recursive: true, force: true })
  }
}
