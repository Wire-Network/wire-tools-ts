import Fs from "node:fs"
import Path from "node:path"
import {
  ClusterFiles,
  DefaultChainStateDbSizeMb
} from "@wireio/cluster-tool-shared"
import type { Argv } from "yargs"
import { Constants } from "../Constants.js"
import { ApiNodeConfig, type ApiNodeOptions } from "../config/ApiNodeConfig.js"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import { DaemonConfig } from "../config/DaemonConfig.js"
import { ApiNodeIniRenderer } from "../config/renderers/ApiNodeIniRenderer.js"
import { ApiNodeStartScriptRenderer } from "../config/renderers/ApiNodeStartScriptRenderer.js"
import { getLogger } from "../logging/Logger.js"
import { StartScriptSteps } from "../orchestration/steps/StartScriptSteps.js"
import { mkdirs } from "../utils/fsUtils.js"
import { ClusterCommand } from "./ClusterCommand.js"

const log = getLogger(__filename)

/**
 * The `create-api-node` command's parsed argv — yargs camelCases every flag.
 *
 * Only the two `demandOption` flags are guaranteed present; every other member
 * is absent when its flag was omitted, which is precisely the signal
 * {@link ApiNodeConfig.resolve} reads to apply that field's default.
 */
export interface CreateApiNodeArgv {
  /** `--output-path` (required). */
  outputPath: string
  /** `--http-server-address` (required). */
  httpServerAddress: string
  /** `--p2p-peer-address`, repeatable. */
  p2pPeerAddress?: string[]
  /** `--chain-state-db-size-mb`. */
  chainStateDbSizeMb?: number
  /** `--transaction-finality-status-max-storage-size-gb`. */
  transactionFinalityStatusMaxStorageSizeGb?: number
  /** `--enable-account-queries`. */
  enableAccountQueries?: boolean
  /** `--http-max-in-flight-requests`. */
  httpMaxInFlightRequests?: number
  /** `--http-threads`. */
  httpThreads?: number
  /** `--agent-name`. */
  agentName?: string
  /** `--genesis-json`. */
  genesisJson?: string
}

/** The artifacts {@link runCreateApiNode} emitted. */
export interface CreateApiNodeResult {
  /** The resolved config every artifact was rendered from. */
  config: ApiNodeConfig
  /** Absolute path of the emitted `config.ini`. */
  configFile: string
  /** Absolute path of the emitted `start.sh` (mode `0755`). */
  startScriptFile: string
  /** Absolute path of the copied genesis, when one was supplied. */
  genesisFile?: string
}

/**
 * Register the command-local flags.
 *
 * Named `.option()`s ONLY — deliberately no `.positional()`, which the CLI
 * test recorders (they implement `option()` + `parserConfiguration()`) cannot
 * capture. Every flag is named for nodeop's OWN option where one exists, per the
 * ticket's "align argument names to the underlying nodeop arguments" bullet.
 *
 * Defaults live in exactly ONE place — {@link ApiNodeConfig.resolve} — so no
 * yargs `default:` is set; each `describe` INTERPOLATES the resolved constant
 * rather than restating it, so `--help` cannot drift from what resolve applies.
 * That keeps a programmatic caller and the CLI on the same resolution path.
 *
 * Every flag whose value becomes an ini line takes its NAME from the ini
 * renderer's option constant, so the two spellings cannot diverge.
 *
 * @param builder - The yargs builder for this command.
 * @returns The builder with every `create-api-node` flag registered.
 */
function applyCreateApiNodeArgs<T>(builder: Argv<T>) {
  return (
    builder
      // Keep every boolean an explicit flag rather than letting yargs mint a
      // `--no-enable-account-queries` negation (matching `create-external-config`).
      .parserConfiguration({ "boolean-negation": false })
      .option("output-path", {
        type: "string",
        demandOption: true,
        describe:
          "destination directory for the emitted config.ini + start.sh (created if absent)"
      })
      .option(ApiNodeIniRenderer.HttpServerAddressOption, {
        type: "string",
        demandOption: true,
        describe: `nodeop ${ApiNodeIniRenderer.HttpServerAddressOption} — the <address>:<port> this node serves on, used verbatim`
      })
      .option(ApiNodeIniRenderer.P2pPeerAddressOption, {
        type: "string",
        array: true,
        describe: `nodeop ${ApiNodeIniRenderer.P2pPeerAddressOption} (<address>:<port>); repeatable — one ini line per value`
      })
      .option(Constants.CHAIN_STATE_DB_SIZE_MB_OPTION, {
        type: "number",
        describe: `nodeop ${Constants.CHAIN_STATE_DB_SIZE_MB_OPTION} (default ${DefaultChainStateDbSizeMb})`
      })
      .option(
        ApiNodeIniRenderer.TransactionFinalityStatusMaxStorageSizeGbOption,
        {
          type: "number",
          describe: `nodeop ${ApiNodeIniRenderer.TransactionFinalityStatusMaxStorageSizeGbOption} — supplying it ENABLES the finality-status feature (default ${ApiNodeConfig.DefaultTransactionFinalityStatusMaxStorageSizeGb})`
        }
      )
      .option(ApiNodeIniRenderer.EnableAccountQueriesOption, {
        type: "boolean",
        describe: `nodeop ${ApiNodeIniRenderer.EnableAccountQueriesOption} (default ${ApiNodeConfig.DefaultEnableAccountQueries}); disable with --${ApiNodeIniRenderer.EnableAccountQueriesOption}=false`
      })
      .option(ApiNodeIniRenderer.HttpMaxInFlightRequestsOption, {
        type: "number",
        describe: `nodeop ${ApiNodeIniRenderer.HttpMaxInFlightRequestsOption} (default ${ApiNodeConfig.DefaultHttpMaxInFlightRequests})`
      })
      .option(ApiNodeIniRenderer.HttpThreadsOption, {
        type: "number",
        describe: `nodeop ${ApiNodeIniRenderer.HttpThreadsOption} (default ${ApiNodeConfig.DefaultHttpThreads})`
      })
      .option(ApiNodeIniRenderer.AgentNameOption, {
        type: "string",
        describe: `nodeop ${ApiNodeIniRenderer.AgentNameOption} (default ${ApiNodeConfig.DefaultAgentName})`
      })
      .option("genesis-json", {
        type: "string",
        describe:
          "optional genesis.json to copy into the output dir and pass as --genesis-json"
      })
  )
}

/**
 * The `create-api-node` command: emit a self-contained `config.ini` +
 * `start.sh` for a STANDALONE (non-cluster) WIRE API node.
 *
 * **Stated departure from its sibling commands.** `create`,
 * `create-external-config`, and `package` each build a `ClusterBuildContext` +
 * `ClusterBuild` and exit on `report.succeeded`. This command has no cluster and
 * no `ClusterConfig` — which `ClusterBuildContext`'s constructor requires — so
 * there is no Report to produce, and the `tools-return-orchestration-units` rule
 * (scoped to chain/process writes inside the orchestration model) does not bind
 * here. What IS inherited from the siblings: the per-file logger, a completion
 * log line, and an explicit exit code. A failed `ApiNodeConfig.resolve`
 * assertion propagates and exits non-zero through yargs' default handler.
 *
 * @returns The yargs command module for `create-api-node`.
 */
export function createCreateApiNodeCommand() {
  return {
    command: ClusterCommand["create-api-node"],
    describe:
      "Generate a standalone (non-cluster) WIRE API node's config.ini + start.sh",
    builder: (builder: Argv) => applyCreateApiNodeArgs(builder),
    handler: async (args: CreateApiNodeArgv) => {
      const result = runCreateApiNode(toApiNodeOptions(args))
      log.info(
        `[api-node] wrote ${result.configFile} + ${result.startScriptFile}`
      )
      process.exit(0)
    }
  }
}

/**
 * Map the parsed argv onto {@link ApiNodeOptions}, nesting the tuning leaves
 * into their own group. An absent flag stays `undefined` so
 * {@link ApiNodeConfig.resolve} supplies its default.
 *
 * @param args - The parsed argv.
 * @returns The caller-options half of the resolution.
 */
export function toApiNodeOptions(args: CreateApiNodeArgv): ApiNodeOptions {
  return {
    outputPath: args.outputPath,
    httpServerAddress: args.httpServerAddress,
    p2pPeerAddresses: args.p2pPeerAddress,
    chainStateDbSizeMb: args.chainStateDbSizeMb,
    genesisJsonFile: args.genesisJson,
    tuning: {
      transactionFinalityStatusMaxStorageSizeGb:
        args.transactionFinalityStatusMaxStorageSizeGb,
      enableAccountQueries: args.enableAccountQueries,
      httpMaxInFlightRequests: args.httpMaxInFlightRequests,
      httpThreads: args.httpThreads,
      agentName: args.agentName
    }
  }
}

/**
 * Resolve, then write every artifact into `options.outputPath`.
 *
 * Extracted from the yargs handler so the whole emission is directly testable —
 * the handler itself only logs and exits (STYLE.md "Extracted Helper
 * Functions"). `--data-dir` is deliberately NOT pre-created: nodeop creates it
 * on first start.
 *
 * @param options - Caller options (CLI argv, or a programmatic caller).
 * @returns The resolved config plus every path written.
 */
export function runCreateApiNode(options: ApiNodeOptions): CreateApiNodeResult {
  const config = ApiNodeConfig.resolve(options),
    outputPath = mkdirs(Path.resolve(config.outputPath)),
    configFile = Path.join(outputPath, ClusterFiles.NodeConfigFilename),
    startScriptFile = DaemonConfig.startScriptFile(outputPath),
    genesisFile =
      config.genesisJsonFile == null
        ? undefined
        : Path.join(outputPath, ClusterConfigProvider.GenesisFilename)

  Fs.writeFileSync(configFile, new ApiNodeIniRenderer(config).render())
  if (genesisFile != null) {
    Fs.copyFileSync(config.genesisJsonFile, genesisFile)
  }
  Fs.writeFileSync(
    startScriptFile,
    new ApiNodeStartScriptRenderer(config).render(),
    { mode: StartScriptSteps.ExecutableMode }
  )
  // Set explicitly as well as at write: `writeFileSync`'s mode applies only when
  // it CREATES the file, so a re-emit over an existing script would otherwise
  // keep the old non-executable bits (same reason as StartScriptSteps.write).
  Fs.chmodSync(startScriptFile, StartScriptSteps.ExecutableMode)

  return { config, configFile, startScriptFile, genesisFile }
}
