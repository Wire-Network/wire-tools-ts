import type { Argv } from "yargs"
import { Constants } from "../Constants.js"
import { KeyGenerator } from "../clients/wire/KeyGenerator.js"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import { ClusterConfigProvider } from "../config/ClusterConfigProvider.js"
import {
  configureCommandLogging,
  getLogger,
  getStdoutLogger
} from "../logging/Logger.js"
import { BatchOperatorKeyTool } from "../tools/wire/BatchOperatorKeyTool.js"
import {
  AWSClusterNodeConfigFlag,
  buildOptionShape,
  ClusterBuildOptionsFileFlag,
  flattenOptionLeaves,
  mergeAWSClusterNodeConfig,
  mergeSignatureProviderKMS,
  mergeSignatureProviderSSM,
  SignatureProviderKMSFlag,
  SignatureProviderSSMFlag,
  toClusterBuildOptions,
  toClusterBuildOptionsFile,
  toFlag,
  toYargsOption
} from "./ClusterBuildOptionsArgs.js"
import { ClusterCommand } from "./ClusterCommand.js"

const log = getLogger(__filename)
const stdout = getStdoutLogger()

/**
 * The option-shape leaves this command shares with `create`, by path: the
 * batch-operator roster size and the provider type. Registered from the SAME
 * `buildOptionShape` entries (same flag spelling, describe and choices), so the
 * two commands cannot drift on how a cluster's keys are described.
 */
const CommandLeafPaths = [["batchOperatorCount"], ["signatureProvider", "type"]]

/**
 * Register the command's flags: the two shared option-shape leaves above plus
 * the four JSON-document flags `create` takes (`--cluster-build-options-file`,
 * `--aws-cluster-node-config`, `--signature-provider-ssm`,
 * `--signature-provider-kms`) — the SAME inputs a `create` of the cluster will
 * read, so the keys are rendered under exactly the ids that create adopts.
 *
 * @param builder - The yargs builder for this command.
 * @param fileOptions - The `--cluster-build-options-file` document (seeds the shared leaves' defaults).
 * @returns The builder with every flag registered.
 */
function applyCreateBatchOperatorKeysArgs(
  builder: Argv,
  fileOptions: ClusterBuildOptions
): Argv {
  const sharedFlags = new Set(CommandLeafPaths.map(path => toFlag(path))),
    withShape = flattenOptionLeaves(buildOptionShape(fileOptions))
      .filter(optionLeaf => sharedFlags.has(optionLeaf.flag))
      .reduce(
        (instance, optionLeaf) =>
          instance.option(optionLeaf.flag, toYargsOption(optionLeaf, fileOptions)),
        builder
      )
  return withShape
    .option(ClusterBuildOptionsFileFlag, {
      type: "string",
      describe:
        "path to the ClusterBuildOptions JSON document the cluster will be created from (batchOperatorCount + signatureProvider); explicit flags beat the file"
    })
    .option(AWSClusterNodeConfigFlag, {
      type: "string",
      describe:
        "path to the AWSClusterNodeConfig JSON file (the AWS account + every region the keys replicate to, plus its ssm and kms settings)"
    })
    .option(SignatureProviderSSMFlag, {
      type: "string",
      describe:
        "SSM publish settings as inline JSON ({awsSecretIdPattern, version?}) or a file path (the regions come from awsClusterNodeConfig)"
    })
    .option(SignatureProviderKMSFlag, {
      type: "string",
      describe:
        "KMS custody settings for the EM keys as inline JSON ({awsKeyAliasPattern, awsRegion, version?}) or a file path"
    })
}

/**
 * The `create-batch-operator-keys` command: pre-create the bootstrap batch
 * operators' signing keys in the cluster's AWS custody store — ahead of the
 * cluster, so a launch can pre-fund them on the outposts — and print the
 * PUBLIC listing (`BatchOperatorKeyTool.KeyListing[]`, JSON) on stdout.
 *
 * It reads the SAME inputs `create` will: the build-options document and the
 * AWS cluster-node config (plus the `--signature-provider-ssm` /
 * `--signature-provider-kms` overrides, same precedence), so every id it
 * publishes under is the one a later `create --signature-provider-batch-operator-key-policy adoptOnly`
 * adopts from. An existing key is adopted, never replaced.
 *
 * **Stated departure from the cluster commands**, like `create-api-node`: there
 * is no cluster and no `ClusterConfig`, so no `ClusterBuildContext`, no Step
 * and no Report. The custody writes go through the SAME primitives the
 * bootstrap's key Steps use (`KeySteps.adoptOrCreateSignatureProviderKey` /
 * `publishSignatureProviderKey`). Inherited from the siblings: the per-file
 * logger, a completion log line and an explicit exit code; a failed
 * resolution assertion propagates and exits non-zero through yargs.
 *
 * @param commandLine - The raw argument array `main()` already filtered.
 * @returns The yargs command module for `create-batch-operator-keys`.
 */
export function createCreateBatchOperatorKeysCommand(
  commandLine: string[] = []
) {
  const fileOptions = toClusterBuildOptionsFile(commandLine) ?? {}
  return {
    command: ClusterCommand["create-batch-operator-keys"],
    describe:
      "Pre-create the batch operators' signing keys in the cluster's AWS custody store (SSM, EM keys in KMS when configured) and print their public listing",
    builder: (builder: Argv) =>
      applyCreateBatchOperatorKeysArgs(builder, fileOptions),
    handler: async (args: Record<string, unknown>) => {
      configureCommandLogging()
      const listing = await runCreateBatchOperatorKeys(
        toCreateBatchOperatorKeysOptions(args, fileOptions)
      )
      stdout.info(JSON.stringify(listing, null, 2))
      log.info(
        `[batch-operator-keys] ${listing.length} keys ready for ${
          listing.length / BatchOperatorKeyTool.KeyTypes.length
        } batch operators`
      )
      process.exit(0)
    }
  }
}

/**
 * Resolve the parsed argv + document into the build options this command
 * works from — the shared leaves via the ONE argv→options mapper, then the
 * node config and the SSM / KMS settings merged with `create`'s precedence
 * (flag > document > node config).
 *
 * @param args - The parsed argv.
 * @param fileOptions - The `--cluster-build-options-file` document.
 * @returns The build options carrying the roster size + custody settings.
 */
export function toCreateBatchOperatorKeysOptions(
  args: Record<string, unknown>,
  fileOptions: ClusterBuildOptions
): ClusterBuildOptions {
  // Node config FIRST: the SSM / KMS merges read its `ssm` / `kms` as their
  // lowest-precedence source.
  return mergeSignatureProviderKMS(
    mergeSignatureProviderSSM(
      mergeAWSClusterNodeConfig(toClusterBuildOptions(args, fileOptions), args),
      args,
      fileOptions
    ),
    args,
    fileOptions
  )
}

/**
 * Resolve the custody settings, adopt-or-create + publish every batch
 * operator's keys and return the PUBLIC listing. Extracted from the yargs
 * handler so the whole operation is directly callable — the handler only prints
 * and exits (STYLE.md "Extracted Helper Functions").
 *
 * @param options - The build options (roster size + custody settings).
 * @returns The public listing rows.
 */
export async function runCreateBatchOperatorKeys(
  options: ClusterBuildOptions
): Promise<BatchOperatorKeyTool.KeyListing[]> {
  const settings = ClusterConfigProvider.resolveKeyCustody(options),
    {
      batchOperatorCount = ClusterConfigProvider.DefaultBatchOperatorCount
    } = options,
    operators = await BatchOperatorKeyTool.adoptOrCreate(
      settings,
      Constants.batchOperatorLabels(batchOperatorCount),
      // No wire-sysio build is needed: K1 / ED / EM generation is in-process.
      KeyGenerator.context()
    )
  return BatchOperatorKeyTool.toListing(settings, operators)
}
