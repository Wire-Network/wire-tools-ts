import Os from "node:os"
import Path from "node:path"

import { ClusterReadinessFeature } from "@wireio/cluster-tool-shared"
import { Level } from "@wireio/shared"
import type { Argv } from "yargs"

import { getLogger, getStdoutLogger } from "../logging/Logger.js"
import { StdoutAppender } from "../logging/StdoutAppender.js"
import { ClusterBuild } from "../orchestration/ClusterBuild.js"
import { ReadinessPhaseGroups } from "../orchestration/ReadinessPhaseGroups.js"
import { ReadinessContext } from "../readiness/ReadinessContext.js"
import { resolveReadinessDeploymentProfile } from "../readiness/ReadinessDeploymentProfileResolver.js"
import { resolveReadinessConfig } from "../readiness/ReadinessEndpointResolver.js"
import { ReadinessReportExporter } from "../readiness/ReadinessReportExporter.js"
import { projectReadinessReport } from "../readiness/ReadinessReportProjector.js"
import { ReadinessTerminalRenderer } from "../readiness/ReadinessTerminalRenderer.js"
import { ClusterCommand } from "./ClusterCommand.js"

const stdout = getStdoutLogger()

/** Parsed arguments for the connected readiness command. */
export interface ReadinessArgv {
  /** Product surface to inspect. */
  feature: ClusterReadinessFeature
  /** Expected Wire chain identity used for endpoint discovery. */
  wireChainId?: string
  /** Optional immutable profile for strict deployment and custody verification. */
  outpostDeploymentProfileFile?: string
  /** Explicit Wire RPC override. */
  wireRpc?: string
  /** Explicit Ethereum JSON-RPC override. */
  ethereumRpc?: string
  /** Explicit Solana JSON-RPC override. */
  solanaRpc?: string
  /** Optional Hyperion base URL override. */
  hyperionUrl?: string
  /** Mutable endpoint catalog URL override. */
  catalogUrl?: string
  /** Maximum head-advancement observation window. */
  observationMs?: number
  /** Per-request timeout. */
  timeoutMs?: number
  /** Emit stable JSON instead of the terminal renderer. */
  json: boolean
  /** Enable ANSI color in terminal output. */
  color: boolean
  /** Export JSON and native HTML reports as a tar archive. */
  export: boolean
  /** Optional archive destination directory. */
  exportDir?: string
}

/**
 * Create the manual connected-readiness yargs command.
 *
 * @return Yargs command module for connected readiness.
 */
export function createReadinessCommand() {
  return {
    command: ClusterCommand.readiness,
    describe: "Run a connected read-only feature readiness preflight",
    builder: (builder: Argv) =>
      builder
        .option("feature", {
          type: "string",
          choices: Object.values(ClusterReadinessFeature),
          default: ClusterReadinessFeature.swap,
          describe: "Feature readiness suite"
        })
        .option("wire-chain-id", {
          type: "string",
          describe: "Expected Wire chain id used for endpoint discovery"
        })
        .option("outpost-deployment-profile-file", {
          type: "string",
          describe:
            "Optional immutable profile for exact deployment and custody verification"
        })
        .option("wire-rpc", {
          type: "string",
          describe:
            "Explicit Wire RPC; also discovers the chain id when omitted"
        })
        .option("ethereum-rpc", {
          type: "string",
          describe: "Explicit Ethereum JSON-RPC override"
        })
        .option("solana-rpc", {
          type: "string",
          describe: "Explicit Solana JSON-RPC override"
        })
        .option("hyperion-url", {
          type: "string",
          describe: "Optional Hyperion base URL override"
        })
        .option("catalog-url", {
          type: "string",
          describe: "Endpoint-catalog URL override"
        })
        .option("observation-ms", {
          type: "number",
          describe: "Maximum head-advancement observation window"
        })
        .option("timeout-ms", {
          type: "number",
          describe: "Timeout for each read-only request"
        })
        .option("json", {
          type: "boolean",
          default: false,
          describe: "Print the stable JSON report instead of terminal output"
        })
        .option("color", {
          type: "boolean",
          default: StdoutAppender.supportsColor(),
          describe: "Use ANSI colors in terminal output"
        })
        .option("export", {
          type: "boolean",
          default: false,
          describe: "Write a tar.gz containing JSON and native report HTML"
        })
        .option("export-dir", {
          type: "string",
          describe: "Archive destination; defaults to ./readiness-reports"
        })
        .check(args => {
          if (!args.wireChainId && !args.wireRpc)
            throw new Error("Provide --wire-chain-id or --wire-rpc")
          return true
        }),
    handler: async (args: ReadinessArgv) => {
      const result = await runReadiness(args)
      process.exitCode = result.exitCode
    }
  }
}

/**
 * Execute one manual readiness run and return its process verdict.
 *
 * @param args Parsed readiness command arguments.
 * @return Readiness reports, optional archive path, and process exit code.
 */
export async function runReadiness(args: ReadinessArgv) {
  const startedAt = new Date(),
    basename = `readiness-${startedAt.getTime()}`,
    config = await resolveReadinessConfig({
      feature: args.feature,
      wireChainId: args.wireChainId,
      ...(args.outpostDeploymentProfileFile
        ? {
            outpostDeploymentProfile: resolveReadinessDeploymentProfile(
              args.outpostDeploymentProfileFile
            )
          }
        : {}),
      wireRpc: args.wireRpc,
      ethereumRpc: args.ethereumRpc,
      solanaRpc: args.solanaRpc,
      hyperionUrl: args.hyperionUrl,
      catalogUrl: args.catalogUrl,
      observationMs: args.observationMs,
      timeoutMs: args.timeoutMs,
      report: {
        path: Path.join(Os.tmpdir(), "wire-cluster-readiness"),
        basename,
        formats: []
      }
    }),
    context = new ReadinessContext(
      config,
      getLogger(basename).setOverrideLevel(Level.fatal)
    ),
    build = ClusterBuild.forContext(context)

  ReadinessPhaseGroups.plan(build, config.feature)
  build.report.name = `${config.feature}-readiness`
  const orchestrationReport = await build.build(),
    report = projectReadinessReport(context, orchestrationReport, startedAt)

  stdout.info(
    args.json
      ? JSON.stringify(report, null, 2)
      : new ReadinessTerminalRenderer(report, { color: args.color }).render()
  )

  let archiveFile: string | null = null
  if (args.export) {
    const archive = await new ReadinessReportExporter(
      report,
      args.exportDir ? { rootPath: Path.resolve(args.exportDir) } : {}
    ).exportArchive()
    archiveFile = archive.archiveFile
    if (!args.json) stdout.info(`Archive: ${archiveFile}`)
  }

  return {
    report,
    orchestrationReport,
    archiveFile,
    exitCode: report.summary.featurePreflightReady ? 0 : 1
  }
}
