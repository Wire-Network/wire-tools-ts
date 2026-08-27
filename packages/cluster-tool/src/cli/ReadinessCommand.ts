import Path from "node:path"
import type { ArgumentsCamelCase, Argv } from "yargs"

import {
  createReadinessConfig,
  ReadinessConfig
} from "../config/ReadinessConfig.js"
import { getLogger } from "../logging/Logger.js"
import { ClusterBuild } from "../orchestration/ClusterBuild.js"
import { ConnectedReadinessContext } from "../orchestration/contexts/ConnectedReadinessContext.js"
import { ReadinessPhaseGroups } from "../orchestration/phases/ReadinessPhaseGroups.js"
import { Report } from "../report/Report.js"
import { ClusterCommand } from "./ClusterCommand.js"

const log = getLogger(__filename)

/** Parsed arguments for a connected-cluster readiness run. */
export interface ReadinessArgv {
  /** WIRE read-only chain API URL. */
  wireRpc: string
  /** Ethereum JSON-RPC URL. */
  ethereumRpc: string
  /** Solana JSON-RPC URL. */
  solanaRpc: string
  /** Expected WIRE chain id. */
  wireChainId: string
  /** Optional expected Ethereum chain id. */
  ethereumChainId?: number
  /** Optional expected Solana genesis hash. */
  solanaGenesisHash?: string
  /** Optional Hyperion base URL. */
  hyperionUrl?: string
  /** Maximum chain-advancement observation window. */
  observationMs: number
  /** Per-request timeout. */
  timeoutMs: number
  /** Native report output directory. */
  reportPath: string
  /** Native report filename stem. */
  reportBasename: string
  /** Native report formats. */
  reportFormat: Report.Format[]
}

/**
 * Create the explicit-endpoint, read-only cluster readiness command.
 *
 * @returns The Yargs command module consumed by the cluster CLI.
 */
export function createReadinessCommand() {
  return {
    command: ClusterCommand.readiness,
    describe:
      "Run read-only cluster and swap preflight checks against explicit endpoints",
    builder: (builder: Argv) => applyReadinessArgs(builder),
    handler: async (args: ArgumentsCamelCase<ReadinessArgv>) => {
      const report = await runReadiness(args)
      log.info(`[readiness] ${report.succeeded ? "SUCCEEDED" : "FAILED"}`)
      process.exitCode = report.succeeded ? 0 : 1
    }
  }
}

/**
 * Execute the reusable readiness PhaseGroups without provisioning a cluster.
 *
 * @param args - Validated connected-readiness CLI arguments.
 * @param request - Fetch implementation used by readiness clients.
 * @returns The completed native readiness Report.
 */
export async function runReadiness(
  args: ReadinessArgv,
  request: typeof fetch = globalThis.fetch
): Promise<Report> {
  const config = createReadinessConfig({
      wireRpc: args.wireRpc,
      ethereumRpc: args.ethereumRpc,
      solanaRpc: args.solanaRpc,
      expectedWireChainId: args.wireChainId,
      expectedEthereumChainId: args.ethereumChainId,
      expectedSolanaGenesisHash: args.solanaGenesisHash,
      hyperionUrl: args.hyperionUrl,
      observationMs: args.observationMs,
      timeoutMs: args.timeoutMs,
      report: {
        path: Path.resolve(args.reportPath),
        basename: args.reportBasename,
        formats: args.reportFormat
      }
    }),
    context = new ConnectedReadinessContext(config, log, request),
    build = ClusterBuild.forContext(context)
  ReadinessPhaseGroups.plan(build)
  build.report.name = ReadinessCommand.ReportName
  return build.build()
}

function applyReadinessArgs(builder: Argv) {
  return builder
    .option("wire-rpc", {
      type: "string",
      demandOption: true,
      describe: "Wire read-only chain API URL"
    })
    .option("ethereum-rpc", {
      type: "string",
      demandOption: true,
      describe: "Ethereum JSON-RPC URL"
    })
    .option("solana-rpc", {
      type: "string",
      demandOption: true,
      describe: "Solana JSON-RPC URL"
    })
    .option("wire-chain-id", {
      type: "string",
      demandOption: true,
      describe: "Expected 64-character Wire chain id"
    })
    .option("ethereum-chain-id", {
      type: "number",
      describe: "Optional expected Ethereum chain id"
    })
    .option("solana-genesis-hash", {
      type: "string",
      describe: "Optional expected Solana genesis hash"
    })
    .option("hyperion-url", {
      type: "string",
      describe: "Optional Hyperion base URL"
    })
    .option("observation-ms", {
      type: "number",
      default: ReadinessConfig.DefaultObservationMs,
      describe: "Maximum head-advancement observation window"
    })
    .option("timeout-ms", {
      type: "number",
      default: ReadinessConfig.DefaultTimeoutMs,
      describe: "Per-request timeout"
    })
    .option("report-path", {
      type: "string",
      default: ReadinessCommand.DefaultReportPath,
      describe: "Directory for native readiness reports"
    })
    .option("report-basename", {
      type: "string",
      default: ReadinessCommand.DefaultReportBasename,
      describe: "Readiness report basename"
    })
    .option("report-format", {
      type: "string",
      array: true,
      choices: Object.values(Report.Format),
      default: ReadinessCommand.DefaultReportFormats,
      coerce: (formats: string[]) => formats as Report.Format[],
      describe: "Native report format; repeat for multiple formats"
    })
}

/** Connected-readiness CLI constants. */
export namespace ReadinessCommand {
  /** Native report name used for connected readiness runs. */
  export const ReportName = "cluster-readiness"
  /** Default connected-readiness report output directory. */
  export const DefaultReportPath = "readiness-reports"
  /** Default connected-readiness report filename stem. */
  export const DefaultReportBasename = "cluster-readiness"
  /** Default report formats emitted by connected readiness. */
  export const DefaultReportFormats = [Report.Format.md, Report.Format.html]
}
