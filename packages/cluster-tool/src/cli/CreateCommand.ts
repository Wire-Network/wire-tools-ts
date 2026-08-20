import { defaultsDeep } from "lodash"
import type { Argv } from "yargs"
import { ClusterManager } from "../cluster/ClusterManager.js"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import { getLogger } from "../logging/Logger.js"
import {
  applyClusterBuildOptionsArgs,
  ClusterPathFlag,
  environmentPathDefaults,
  hasCommandLineFlag,
  mergeAWSClusterNodeConfig,
  mergeSignatureProviderSSM,
  toClusterBuildOptions,
  toClusterBuildOptionsFile
} from "./ClusterBuildOptionsArgs.js"
import { ClusterCommand } from "./ClusterCommand.js"

const log = getLogger(__filename)

/**
 * The `create` command: bootstrap a brand-new cluster from the shared
 * {@link applyClusterBuildOptionsArgs} flag surface — the SAME surface every
 * `flow-*` executable uses (one implementation, no CLI/flow duplication). The
 * process exit code mirrors the bootstrap {@link Report}'s success.
 *
 * `--cluster-build-options-file` is read from the RAW `commandLine` here, before
 * yargs parses anything: its document seeds every other flag's default, so it
 * has to be known at builder time. The loaded document is a PER-COMMAND local
 * closed over by both `builder` and `handler` — never module state, so nothing
 * leaks between invocations (or between tests).
 *
 * Precedence: explicit CLI flags > the file > `WIRE_*` env > `CliDefault`. The
 * file-over-env layer is PRE-COMPOSED here and handed to
 * {@link applyClusterBuildOptionsArgs} with an EMPTY environment, so the shared
 * function's own (env-highest) layer stays inert for `create` — `FlowCLI`'s
 * "env beats scenario defaults" semantics are untouched.
 *
 * @param commandLine - The raw argument array `main()` already filtered.
 * @returns The yargs command module for `create`.
 */
export function createCreateCommand(commandLine: string[] = []) {
  const fileOptions = toClusterBuildOptionsFile(commandLine),
    explicitClusterPath = hasCommandLineFlag(commandLine, ClusterPathFlag)
  return {
    command: ClusterCommand.create,
    describe: "Create + bootstrap a new cluster",
    builder: (builder: Argv) =>
      applyClusterBuildOptionsArgs(
        builder,
        defaultsDeep({}, fileOptions ?? {}, environmentPathDefaults(process.env)),
        {}
      ),
    handler: async (args: Record<string, unknown>) => {
      ClusterConfigProvider.assertClusterPathSource(fileOptions, explicitClusterPath)
      // Node config FIRST: `mergeSignatureProviderSSM` reads its `ssm` as the
      // lowest-precedence SSM source.
      const report = await ClusterManager.create(
        mergeSignatureProviderSSM(
          mergeAWSClusterNodeConfig(toClusterBuildOptions(args, fileOptions ?? {}), args),
          args,
          fileOptions
        )
      )
      log.info(`[cluster] bootstrap ${report.succeeded ? "SUCCEEDED" : "FAILED"}`)
      process.exit(report.succeeded ? 0 : 1)
    }
  }
}
