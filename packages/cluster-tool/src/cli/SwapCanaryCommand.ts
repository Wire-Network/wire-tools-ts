import Path from "node:path"

import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import type { ArgumentsCamelCase, Argv } from "yargs"

import { ClusterState } from "../cluster/ClusterState.js"
import { SwapCanaryConfig } from "../config/SwapCanaryConfig.js"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import { getLogger } from "../logging/Logger.js"
import { ClusterBuild } from "../orchestration/ClusterBuild.js"
import { SwapCanaryPhaseGroups } from "../orchestration/phases/SwapCanaryPhaseGroups.js"
import { Report } from "../report/Report.js"
import {
  SwapRouteCatalog,
  SwapRouteSelector
} from "../tools/all/SwapRouteCatalog.js"
import { SwapScenarioContext } from "../flow/contexts/SwapScenarioContext.js"
import { currentDateStamp } from "../utils/fsUtils.js"
import {
  applyClusterPathArgs,
  type ClusterPathArgv
} from "./ClusterPathArgs.js"
import { ClusterCommand } from "./ClusterCommand.js"

const log = getLogger(__filename)
const { SysioContractName } = SysioContracts

/** Parsed arguments for a transactional canary against an existing cluster. */
export interface SwapCanaryArgv extends ClusterPathArgv {
  /** Unioned route selector strings. */
  readonly routes: readonly string[]
  /** Whether to wait through every exact UWREQ challenge window. */
  readonly waitForChallenge: boolean
  /** Optional report directory override. */
  readonly reportPath?: string
}

interface ConnectedSwapCanaryConfigOptions {
  readonly clusterPath: string
  readonly reportPath?: string
}

/** Create the existing-cluster transactional swap-canary command. */
export function createSwapCanaryCommand() {
  return {
    command: ClusterCommand["swap-canary"],
    describe:
      "Run the transactional swap canary against an already-running cluster",
    builder: (builder: Argv) => applySwapCanaryArgs(builder),
    handler: async (args: ArgumentsCamelCase<SwapCanaryArgv>) => {
      const report = await runSwapCanary(args)
      log.info(
        `[swap-canary] ${report.succeeded ? "SUCCEEDED" : "FAILED"}`
      )
      process.exitCode = report.succeeded ? 0 : 1
    }
  }
}

/**
 * Execute the shared canary PhaseGroups against a persisted, running cluster.
 * Bootstrap and collateral writes are deliberately omitted; their live state
 * is verified before the selected route transactions begin.
 *
 * @param args - Existing cluster path, selectors, and report options.
 * @returns The completed native canary Report.
 */
export async function runSwapCanary(args: SwapCanaryArgv): Promise<Report> {
  const config = createConnectedSwapCanaryConfig(args),
    context = new SwapScenarioContext(
      config,
      getLogger(SwapCanaryCommand.ReportBasename)
    )

  // Validate both persisted halves before any transaction is planned, then
  // rehydrate the exact operator handles the shared readiness phases consume.
  ClusterState.load(config)
  ClusterState.rehydrate(context.keyStore, ClusterState.loadKeys(config))

  const { rows: liveReserves } = await context.wire
      .getSysioContract(SysioContractName.reserv)
      .tables.reserves.query({ limit: SwapCanaryConfig.TableRowLimit }),
    cluster = ClusterBuild.forContext(context)
  SwapCanaryPhaseGroups.plan(cluster, {
    availableRoutes: SwapRouteCatalog.fromLiveReserveRows(liveReserves),
    routes: SwapRouteCatalog.parseSelectors(args.routes.map(String)),
    waitForChallenge: args.waitForChallenge,
    provisionUnderwriterCollateral: false
  })
  cluster.report.name = SwapCanaryCommand.ReportName
  return cluster.build()
}

/**
 * Load a persisted cluster config and derive an isolated connected-canary
 * report target without changing the cluster's saved configuration.
 *
 * @param args - Existing cluster path and optional report override.
 * @returns Validated in-memory config for connected canary execution.
 */
export function createConnectedSwapCanaryConfig(
  args: ConnectedSwapCanaryConfigOptions
): ClusterConfig {
  const clusterPath = Path.resolve(args.clusterPath),
    persisted = ClusterConfigProvider.loadSync(
      Path.join(clusterPath, ClusterConfigProvider.ConfigFilename)
    ),
    reportPath =
      args.reportPath != null
        ? Path.resolve(args.reportPath)
        : Path.join(
            clusterPath,
            SwapCanaryCommand.ReportSubpath,
            currentDateStamp()
          )

  return ClusterConfigProvider.deserialize(
    JSON.stringify({
      ...persisted,
      report: {
        ...persisted.report,
        path: reportPath,
        basename: SwapCanaryCommand.ReportBasename
      }
    })
  )
}

function applySwapCanaryArgs<T>(builder: Argv<T>) {
  return applyClusterPathArgs(builder)
    .option("routes", {
      type: "string",
      array: true,
      choices: Object.values(SwapRouteSelector),
      default: [SwapRouteSelector.canary],
      describe:
        "Route selector; repeat to union groups (default: one public reserve per endpoint)"
    })
    .option("wait-for-challenge", {
      type: "boolean",
      default: false,
      describe: "Wait for every exact UWREQ to reach COMPLETED"
    })
    .option("report-path", {
      type: "string",
      describe: "Report directory (default: timestamped path under the cluster)"
    })
}

/** Connected swap-canary command constants. */
export namespace SwapCanaryCommand {
  /** Report title distinguishes connected execution from fresh-cluster flow runs. */
  export const ReportName = "swap-canary-connected"
  /** Stable report filename within each timestamped directory. */
  export const ReportBasename = "swap-canary"
  /** Cluster-relative parent for connected canary reports. */
  export const ReportSubpath = Path.join("reports", "swap-canary")
}
