import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import type { Argv } from "yargs"
import { ClusterManager } from "../cluster/ClusterManager.js"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import { getLogger } from "../logging/Logger.js"
import { ClusterBuild } from "../orchestration/ClusterBuild.js"
import { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"
import { ClusterBuildPhase } from "../orchestration/ClusterBuildPhase.js"
import { ClusterBuildPhaseGroup } from "../orchestration/ClusterBuildPhaseGroup.js"
import { ExternalClusterConfigSteps } from "../orchestration/steps/ExternalClusterConfigSteps.js"
import { Report } from "../report/Report.js"
import { ClusterCommand } from "./ClusterCommand.js"

const log = getLogger(__filename)

/** The `create-external-config` command's parsed argv — the two paths + the external bind file. */
interface CreateExternalConfigArgv {
  localClusterPath: string
  externalClusterPath: string
  externalBindConfig: string
  noDebuggingServer: boolean
}

/** Add the three required, command-local path options (two paths → not `applyClusterPathArgs`). */
function applyCreateExternalConfigArgs<T>(builder: Argv<T>) {
  return builder
    // Keep `--no-debugging-server` a plain boolean flag rather than yargs'
    // implicit negation of a `debugging-server` option.
    .parserConfiguration({ "boolean-negation": false })
    .option("local-cluster-path", {
      type: "string",
      demandOption: true,
      describe: "the CREATED local cluster directory to clone"
    })
    .option("external-cluster-path", {
      type: "string",
      demandOption: true,
      describe: "destination external cluster directory (MUST be empty or non-existent)"
    })
    .option("external-bind-config", {
      type: "string",
      demandOption: true,
      describe: "path to the external BindConfig JSON to merge in"
    })
    .option("no-debugging-server", {
      type: "boolean",
      default: false,
      describe:
        "disable the OPP debugging server in the emitted external cluster (drops the sink plugin + --ext-debugging-server from the operator daemons and skips starting the server)"
    })
}

/**
 * The `create-external-config` command: clone a CREATED, STOPPED local cluster
 * into a deployable external cluster directory with the external `BindConfig`
 * merged in, and emit its self-described `ExternalClusterConfig`. Runs the
 * five-stage {@link ExternalClusterConfigSteps} pipeline (Validate → Clone →
 * Rebind → Emit → Verify); exit mirrors the Report.
 *
 * @returns The yargs command module for `create-external-config`.
 */
export function createCreateExternalConfigCommand() {
  return {
    command: ClusterCommand["create-external-config"],
    describe:
      "Clone a created local cluster into a deployable external cluster directory + emit its ExternalClusterConfig",
    builder: (builder: Argv) => applyCreateExternalConfigArgs(builder),
    handler: async (args: CreateExternalConfigArgv) => {
      const report = await runCreateExternalConfig(
        Path.resolve(args.localClusterPath),
        Path.resolve(args.externalClusterPath),
        Path.resolve(args.externalBindConfig),
        args.noDebuggingServer === true
      )
      log.info(
        `[cluster] create-external-config ${report.succeeded ? "SUCCEEDED" : "FAILED"}`
      )
      process.exit(report.succeeded ? 0 : 1)
    }
  }
}

/** Load + guard the inputs, compose the five-stage build, and run it. */
async function runCreateExternalConfig(
  localClusterPath: string,
  externalClusterPath: string,
  externalBindConfigFile: string,
  noDebuggingServer: boolean
): Promise<Report> {
  const config = ClusterConfigProvider.loadSync(
    Path.join(localClusterPath, ClusterConfigProvider.ConfigFilename)
  )
  ClusterManager.assertClusterStopped(config)
  Assert.ok(
    !Fs.existsSync(externalClusterPath) ||
      Fs.readdirSync(externalClusterPath).length === 0,
    `create-external-config: --external-cluster-path ${externalClusterPath} must be empty or non-existent`
  )
  Assert.ok(
    Fs.existsSync(externalBindConfigFile),
    `create-external-config: --external-bind-config ${externalBindConfigFile} not found`
  )

  const context = new ClusterBuildContext(
      config,
      getLogger(config.report.basename)
    ),
    cluster = ClusterBuild.forContext(context)
  context.outputs.set(ExternalClusterConfigSteps.ParamsKey, {
    externalClusterPath,
    externalBindConfigFile,
    noDebuggingServer
  })

  const group = ClusterBuildPhaseGroup.create(
    cluster,
    "CreateExternalConfig",
    "Clone a local cluster into an external cluster directory + emit its config"
  )
  const { Actor } = Report
  ExternalClusterConfigSteps.planValidatePhase(group, Actor.Sysio, {})
  ClusterBuildPhase.create(group, "Clone", "Copy the local tree to the external path", [
    ExternalClusterConfigSteps.planClone(
      Actor.Sysio,
      "clone",
      "clone the cluster tree (runtime artifacts excluded)",
      {}
    )
  ])
  ClusterBuildPhase.create(group, "Rebind", "Re-render every file from the merged model", [
    ExternalClusterConfigSteps.planRebind(
      Actor.Sysio,
      "rebind",
      "merge to the external root + re-render config/genesis/nodes/state",
      {}
    )
  ])
  ClusterBuildPhase.create(group, "Emit", "Emit external-cluster-config.json", [
    ExternalClusterConfigSteps.planEmit(
      Actor.Sysio,
      "emit",
      "write the self-described external cluster config",
      {}
    )
  ])
  ClusterBuildPhase.create(group, "Verify", "Scan for stale local bind + round-trip", [
    ExternalClusterConfigSteps.planVerify(
      Actor.Sysio,
      "verify",
      "self-validation backstop",
      {}
    )
  ])

  cluster.report.name = "create-external-config"
  return cluster.build()
}
