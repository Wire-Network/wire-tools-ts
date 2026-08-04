import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import type { Argv } from "yargs"
import { ClusterManager } from "../cluster/ClusterManager.js"
import { ClusterPackageType } from "../cluster/ClusterPackageType.js"
import { ClusterState } from "../cluster/ClusterState.js"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import { NodeConfig } from "../config/NodeConfig.js"
import { getLogger } from "../logging/Logger.js"
import { ClusterBuild } from "../orchestration/ClusterBuild.js"
import { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"
import { ClusterBuildPhase } from "../orchestration/ClusterBuildPhase.js"
import { ClusterBuildPhaseGroup } from "../orchestration/ClusterBuildPhaseGroup.js"
import { ClusterPackageSteps } from "../orchestration/steps/ClusterPackageSteps.js"
import { Report } from "../report/Report.js"
import {
  applyClusterPathArgs,
  type ClusterPathArgv
} from "./ClusterPathArgs.js"
import { ClusterCommand } from "./ClusterCommand.js"

const log = getLogger(__filename)

/** The `package` command's parsed argv — cluster path + the coerced package type. */
interface PackageArgv extends ClusterPathArgv {
  packageType: ClusterPackageType
}

/** Coerce a raw `--package-type` value case-insensitively to a {@link ClusterPackageType}. */
export function toClusterPackageType(raw: string): ClusterPackageType {
  const upper = String(raw).toUpperCase(),
    matched = Object.values(ClusterPackageType).find(type => type === upper)
  Assert.ok(
    matched != null,
    `unknown --package-type "${raw}" — valid: ${Object.values(ClusterPackageType).join(", ")}`
  )
  return matched
}

/** Add the required, case-insensitive `--package-type` flag (coerced to the enum). */
function applyPackageTypeArg<T>(builder: Argv<T>) {
  return builder.option("package-type", {
    type: "string",
    demandOption: true,
    coerce: (raw: string) => toClusterPackageType(raw),
    describe: `archive format: ${Object.values(ClusterPackageType).join(", ")} (case-insensitive)`
  })
}

/**
 * The `package` command: archive each node's full config tree (+ the cluster
 * `genesis.json`) into `<clusterPath>/packages/<node>.<ext>`, ONE archive per
 * node. Runs ONLY on a successfully-`create`d, STOPPED cluster (the hand-off
 * artifact for a multihost environment with distinct compute + storage, e.g.
 * S3/EC2 — loosely coupled, never provider-specific). Exit mirrors the Report.
 *
 * @returns The yargs command module for `package`.
 */
export function createPackageCommand() {
  return {
    command: ClusterCommand.package,
    describe:
      "Package each node's config tree into a per-node archive (post-create)",
    builder: (builder: Argv) => applyPackageTypeArg(applyClusterPathArgs(builder)),
    handler: async (args: PackageArgv) => {
      const report = await runPackage(
        Path.resolve(args.clusterPath),
        args.packageType
      )
      log.info(`[cluster] package ${report.succeeded ? "SUCCEEDED" : "FAILED"}`)
      process.exit(report.succeeded ? 0 : 1)
    }
  }
}

/** Load + validate the cluster, compose the per-node archive build, and run it. */
async function runPackage(
  clusterPath: string,
  packageType: ClusterPackageType
): Promise<Report> {
  const config = ClusterConfigProvider.loadSync(
    Path.join(clusterPath, ClusterConfigProvider.ConfigFilename)
  )
  Assert.ok(
    Fs.existsSync(ClusterState.stateFilePath(config)),
    `package: ${ClusterState.stateFilePath(config)} not found — run "wire-cluster-tool create" first`
  )
  ClusterManager.assertClusterStopped(config)
  const context = new ClusterBuildContext(
      config,
      getLogger(config.report.basename)
    ),
    cluster = ClusterBuild.forContext(context),
    group = ClusterBuildPhaseGroup.create(
      cluster,
      "Package",
      "Per-node archives"
    )
  NodeConfig.plan(config).forEach(node =>
    ClusterBuildPhase.create(group, `package-${node.name}`, `archive ${node.name}`, [
      ClusterPackageSteps.planPackageNode(
        Report.Actor.Sysio,
        `package-${node.name}`,
        `archive ${node.name} → ${packageType}`,
        {},
        node.name,
        packageType
      )
    ])
  )
  cluster.report.name = "package"
  return cluster.build()
}
