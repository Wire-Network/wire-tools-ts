import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"

import { defaultsDeep, isString } from "lodash"
import type { Argv } from "yargs"
import {
  BatchOperatorUnderwritingConfig,
  ExternalOutpostConfigSchemaCodec,
  type ExternalOutpostConfig
} from "@wireio/cluster-tool-shared"

import { Constants } from "../Constants.js"
import { KeyGenerator } from "../clients/wire/KeyGenerator.js"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import {
  configureCommandLogging,
  getLogger,
  getStdoutLogger
} from "../logging/Logger.js"
import { BatchOperatorFundingTool } from "../tools/all/BatchOperatorFundingTool.js"
import { EthereumOutpostTarget } from "../tools/ethereum/EthereumOutpostTarget.js"
import { SolanaOutpostTarget } from "../tools/solana/SolanaOutpostTarget.js"
import {
  applyCustodyDocumentArgs,
  buildOptionShape,
  environmentPathDefaults,
  flattenOptionLeaves,
  toClusterBuildOptionsFile,
  toFlag,
  toYargsOption
} from "./ClusterBuildOptionsArgs.js"
import { ClusterCommand } from "./ClusterCommand.js"
import { toCreateBatchOperatorKeysOptions } from "./CreateBatchOperatorKeysCommand.js"

const log = getLogger(__filename)
const stdout = getStdoutLogger()

/**
 * The option-shape leaves this command shares with `create`, by path: the
 * batch-operator roster size, the underwriting role flag (whose
 * `batchOperatorUnderwriting` document member carries the stake + reserve),
 * the two outpost repo roots (the ABI / IDL artifacts), the external outpost
 * config path and the provider type. Registered from the SAME
 * `buildOptionShape` entries `create` registers (same flag spelling, describe
 * and choices), so the two commands cannot drift on how a launch is described.
 */
const CommandLeafPaths = [
  ["batchOperatorCount"],
  ["enableBatchOperatorUnderwriting"],
  ["ethereumPath"],
  ["solanaPath"],
  ["externalOutpostConfig"],
  ["signatureProvider", "type"]
]

/**
 * Register the command's flags: the shared option-shape leaves above
 * (seeded from the `--cluster-build-options-file` document, then the `WIRE_*`
 * path variables, like `create`) plus the four custody-document flags
 * (`applyCustodyDocumentArgs`) — the SAME inputs a `create` of the cluster
 * reads, so the keys are adopted under exactly the ids create adopts.
 *
 * @param builder - The yargs builder for this command.
 * @param fileOptions - The `--cluster-build-options-file` document.
 * @returns The builder with every flag registered.
 */
function applyFundBatchOperatorsArgs(
  builder: Argv,
  fileOptions: ClusterBuildOptions
): Argv {
  const seededDefaults: ClusterBuildOptions = defaultsDeep(
      {},
      fileOptions,
      environmentPathDefaults(process.env)
    ),
    sharedFlags = new Set(CommandLeafPaths.map(path => toFlag(path))),
    withShape = flattenOptionLeaves(buildOptionShape(seededDefaults))
      .filter(optionLeaf => sharedFlags.has(optionLeaf.flag))
      .reduce(
        (instance, optionLeaf) =>
          instance.option(optionLeaf.flag, toYargsOption(optionLeaf, seededDefaults)),
        builder
      )
  return applyCustodyDocumentArgs(withShape)
}

/**
 * The `fund-batch-operators` command: fund the pre-created bootstrap batch
 * operators on BOTH deployed outposts — adopt each operator's keys
 * (adopt-only), check its native balance covers `stake + reserve`, and stake
 * the configured amount so the launch snapshot carries its position — and
 * print the receipt listing (`BatchOperatorFundingTool.Receipt[]`, JSON) on
 * stdout. Exit `0` iff every operator was funded on every outpost; a write
 * failure prints what landed, logs the failure and exits `1`.
 *
 * It reads the SAME inputs `create` will — the build-options document (its
 * `batchOperatorUnderwriting.stake` / `.reserve` are the amounts), the AWS
 * cluster-node config and the `--signature-provider-*` overrides — plus the
 * external outpost config (the deployed outposts' RPC endpoints, addresses,
 * program id and mints) and the two outpost repo roots (the ABI / IDL
 * artifacts).
 *
 * **Stated departure from the cluster commands**, like
 * `create-batch-operator-keys`: there is no cluster and no `ClusterConfig`, so
 * no `ClusterBuildContext`, no Step and no Report. The reads and builds go
 * through the SAME tool primitives the flow Steps use, addressed by the
 * outpost targets an `ExternalOutpostConfig` composes. Inherited from the
 * siblings: the per-file logger, a completion log line and an explicit exit
 * code; a failed precondition propagates and exits non-zero through yargs
 * before any transaction is sent.
 *
 * @param commandLine - The raw argument array `main()` already filtered.
 * @returns The yargs command module for `fund-batch-operators`.
 */
export function createFundBatchOperatorsCommand(commandLine: string[] = []) {
  const fileOptions = toClusterBuildOptionsFile(commandLine) ?? {}
  return {
    command: ClusterCommand["fund-batch-operators"],
    describe:
      "Fund the pre-created batch operators on both deployed outposts (stake + verify the gas reserve) and print the transaction receipts",
    builder: (builder: Argv) => applyFundBatchOperatorsArgs(builder, fileOptions),
    handler: async (args: Record<string, unknown>) => {
      configureCommandLogging()
      const outcome = await runFundBatchOperators(
          toFundBatchOperatorsOptions(args, fileOptions)
        ),
        { receipts, skips, failure } = outcome
      stdout.info(BatchOperatorFundingTool.toListingJson(outcome))
      if (failure != null) {
        log.error(
          `[fund-batch-operators] FAILED funding ${failure.label} on ${failure.chain}: ${failure.error.message} — ${receipts.length} transactions landed and ${skips.length} legs were skipped before it (listed on stdout)`
        )
        process.exit(1)
      }
      log.info(
        `[fund-batch-operators] ${receipts.length} transactions landed, ${skips.length} legs skipped for an existing position — every operator funded on both outposts`
      )
      process.exit(0)
    }
  }
}

/**
 * Resolve the parsed argv + document into the build options this command
 * works from — the shared leaves via the ONE argv→options mapper, then the
 * node config and the SSM / KMS settings merged with `create`'s precedence
 * (flag > document > node config). The SAME resolution
 * `create-batch-operator-keys` performs, so the two pre-launch commands adopt
 * under identical ids.
 *
 * @param args - The parsed argv.
 * @param fileOptions - The `--cluster-build-options-file` document.
 * @returns The build options carrying the roster, custody settings, amounts and paths.
 */
export function toFundBatchOperatorsOptions(
  args: Record<string, unknown>,
  fileOptions: ClusterBuildOptions
): ClusterBuildOptions {
  return toCreateBatchOperatorKeysOptions(args, fileOptions)
}

/**
 * Load + validate the `--external-outpost-config` document — the deployed
 * outposts' trusted, value-only description.
 *
 * @param file - Path to the JSON document (resolved absolute).
 * @returns The decoded config.
 * @throws When the file is unreadable or not an `ExternalOutpostConfig`.
 */
export function loadExternalOutpostConfig(file: string): ExternalOutpostConfig {
  return ExternalOutpostConfigSchemaCodec.deserialize(
    Fs.readFileSync(Path.resolve(file), "utf-8")
  )
}

/**
 * The two outpost targets an external config describes, dialed through a
 * plain provider / connection (no cluster, so no recording clients).
 *
 * @param external - The decoded external outpost config.
 * @param ethereumPath - The `wire-ethereum` repo root (artifacts).
 * @param solanaPath - The `wire-solana` repo root (IDL + program ids).
 * @returns The targets.
 * @throws If either outpost carries no `rpcUrl`.
 */
export function createTargets(
  external: ExternalOutpostConfig,
  ethereumPath: string,
  solanaPath: string
): BatchOperatorFundingTool.Targets {
  return {
    ethereum: EthereumOutpostTarget.fromExternalOutpost(
      external.ethereum,
      ethereumPath,
      EthereumOutpostTarget.createProvider(
        EthereumOutpostTarget.assertRpcUrl(external.ethereum)
      )
    ),
    solana: SolanaOutpostTarget.fromExternalOutpost(
      external.solana,
      solanaPath,
      SolanaOutpostTarget.createConnection(
        SolanaOutpostTarget.assertRpcUrl(external.solana)
      )
    )
  }
}

/**
 * Assert a path option the command cannot run without was supplied — by flag,
 * by the document, or by its `WIRE_*` variable.
 *
 * @param value - The option's value.
 * @param flag - The option's flag, for the message.
 * @returns The value.
 */
function assertPathOption(value: string, flag: string): string {
  Assert.ok(
    isString(value) && value.trim().length > 0,
    `fund-batch-operators requires --${flag}`
  )
  return value
}

/**
 * Resolve the custody settings and the amounts, adopt every funded operator's
 * keys, and fund them. Extracted from the yargs handler so the whole operation
 * is directly callable — the handler only prints and exits (STYLE.md
 * "Extracted Helper Functions").
 *
 * The operators funded are the first `batchOperatorUnderwriting.fundedOperatorCount`
 * of the roster (every operator by default) — the underwriting operators, whose
 * pre-funded stake IS their underwriting inventory; a document that does not
 * enable the underwriting role has nothing to fund.
 *
 * @param options - The build options (roster, custody settings, amounts, paths, external config).
 * @returns Every landed receipt, plus the failure that stopped the run if one did.
 * @throws On an unmet precondition — before any transaction is sent.
 */
export async function runFundBatchOperators(
  options: ClusterBuildOptions
): Promise<BatchOperatorFundingTool.Outcome> {
  const settings = ClusterConfigProvider.resolveKeyCustody(options),
    {
      batchOperatorCount = ClusterConfigProvider.DefaultBatchOperatorCount
    } = options,
    externalOutpostConfig = assertPathOption(
      options.externalOutpostConfig,
      toFlag(["externalOutpostConfig"])
    ),
    ethereumPath = assertPathOption(options.ethereumPath, toFlag(["ethereumPath"])),
    solanaPath = assertPathOption(options.solanaPath, toFlag(["solanaPath"])),
    underwriting = ClusterConfigProvider.resolveBatchOperatorUnderwriting(
      options,
      batchOperatorCount
    )
  Assert.ok(
    underwriting != null,
    "fund-batch-operators: the build options do not enable batch-operator underwriting (enableBatchOperatorUnderwriting) — the operators a launch pre-funds are its underwriting operators, so there is nothing to fund"
  )
  const {
      fundedOperatorCount,
      stake = BatchOperatorUnderwritingConfig.defaultStake(),
      reserve = BatchOperatorUnderwritingConfig.defaultReserve()
    } = underwriting,
    labels = Constants.batchOperatorLabels(batchOperatorCount).slice(
      0,
      fundedOperatorCount
    )
  Assert.ok(
    labels.length > 0,
    "fund-batch-operators: batchOperatorUnderwriting.fundedOperatorCount is 0 — no operator to fund"
  )
  const targets = createTargets(
      loadExternalOutpostConfig(externalOutpostConfig),
      ethereumPath,
      solanaPath
    ),
    operators = await BatchOperatorFundingTool.adoptOperators(
      settings,
      labels,
      // No wire-sysio build is needed: nothing is generated under adopt-only.
      KeyGenerator.context()
    )
  return BatchOperatorFundingTool.fund(operators, { stake, reserve }, targets)
}
