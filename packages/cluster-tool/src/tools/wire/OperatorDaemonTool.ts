/**
 * OperatorDaemonTool — everything an OPERATOR nodeop daemon (batch operator /
 * underwriter) needs beyond the base node args: the OPP plugin set, the WIRE +
 * outpost `--signature-provider` specs (from the operator's {@link OperatorAccount}
 * in `ctx.keyStore`), the outpost client specs, and the deploy artifacts (ETH ABI
 * files with embedded addresses, the SOL program id + IDL).
 *
 * {@link planArtifactPreparation} is a Step (run once, after both outpost deploys) that
 * writes the cluster-local artifact files and stores the typed
 * {@link OperatorDaemonArtifacts}; {@link batchOperatorArgs} /
 * {@link underwriterArgs} are PURE value builders the operator-node start runner
 * composes into `NodeopProcess` extra args.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { type ClusterConfig, NodeopReadMode } from "@wireio/cluster-tool-shared"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { match } from "ts-pattern"
import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { BindConfigProvider } from "../../config/BindConfigProvider.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { NodeConfig } from "../../config/NodeConfig.js"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import { NodeopProcess } from "../../cluster/processes/NodeopProcess.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { OperatorAccount } from "../../orchestration/outputs/OperatorAccount.js"
import {
  OperatorDaemonArtifacts,
  OperatorDaemonArtifactsKey
} from "../../orchestration/outputs/OperatorDaemonArtifacts.js"
import { Report } from "../../report/Report.js"
import { StepExtraRecorder } from "../../report/tools/StepExtraRecorder.js"
import { SolanaOutpostProgramTool } from "../solana/SolanaOutpostProgramTool.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { scaleTimeoutMs } from "../../utils/asyncUtils.js"
import { toDialAddress, toURL } from "../../utils/netUtils.js"

export namespace OperatorDaemonTool {
  // ── plugin sets ────────────────────────────────────────────────────────────

  /** The OPP-debugging sink plugin — reports OPP envelope artifacts to the
   *  external debugging server; dropped from a daemon's plugin set when the
   *  cluster's debugging server is disabled (`debuggingServerEnabled === false`). */
  export const ExternalDebuggingPlugin = "sysio::external_debugging_plugin"

  /** Plugins a batch-operator daemon loads. */
  export const BatchOperatorPlugins = [
    "sysio::batch_operator_plugin",
    ExternalDebuggingPlugin,
    "sysio::outpost_ethereum_client_plugin",
    "sysio::outpost_solana_client_plugin",
    "sysio::cron_plugin"
  ] as const

  /** `plugins` with the external-debugging sink removed when the server is off. */
  const debuggingGatedPlugins = (
    plugins: readonly string[],
    debuggingServerEnabled: boolean
  ): readonly string[] =>
    debuggingServerEnabled
      ? plugins
      : plugins.filter(plugin => plugin !== ExternalDebuggingPlugin)

  // ── daemon tuning + protocol constants ────────────────────────────────────

  /** batch_operator_plugin epoch poll interval (ms). */
  export const BatchEpochPollMs = 15_000
  /** batch_operator_plugin delivery timeout (ms; nominal — scaled at arg build). */
  export const BatchDeliveryTimeoutMs = 30_000
  /** The `sysio.chains` codename identifying the ETH outpost. */
  export const EthereumChainCodename = "ETHEREUM"
  /** The `sysio.chains` codename identifying the SOL outpost. */
  export const SolanaChainCodename = "SOLANA"
  /**
   * Outpost RPC client ids ARE the chain codes.
   *
   * Both operator daemons look a chain's RPC client up under that chain's
   * `sysio.chains` code, so the id passed to `--outpost-{ethereum,solana}-client`
   * must be the codename and nothing else. A client registered under any other
   * id is invisible to them, and a batch operator that cannot reach an active
   * chain shuts down rather than relaying a partial epoch.
   */
  export const EthereumClientId = EthereumChainCodename
  /** See {@link EthereumClientId} — the SOL client id is likewise the chain code. */
  export const SolanaClientId = SolanaChainCodename
  /** SOL inbound-delivery instruction the batch operator invokes. */
  export const SolanaEpochInInstruction = "epoch_in"
  /**
   * OPP outpost instructions the daemons invoke — asserted present in the
   * copied IDL so a wrong or stale IDL fails at artifact preparation, not at
   * the first delivery.
   */
  export const RequiredSolanaIdlInstructions = [
    SolanaEpochInInstruction
  ] as const
  /** OPP outpost contracts whose ABIs (with embedded addresses) the plugins load. */
  export const EthereumAbiContractNames = ["OPP", "OPPInbound", "BAR"] as const
  /** Cluster-data subpath holding the generated `{contractName, address, abi}` files. */
  export const EthereumAbiSubpath = "eth-abis"
  /** Cluster-data subpath holding the copied OPP outpost IDL. */
  export const SolanaIdlSubpath = "solana-idls"
  /** The OPP outpost IDL filename (cluster-local verbatim copy). */
  export const SolanaIdlFilename = `${SolanaOutpostProgramTool.ProgramName}.json`

  // ── network endpoints the daemon dials ─────────────────────────────────────

  /** The chain endpoints + debugging sink an operator daemon dials. */
  export interface OperatorDaemonNetwork {
    readonly ethereumRpcUrl: string
    readonly ethereumChainId: number
    readonly solanaRpcUrl: string
    readonly debuggingServerUrl: string
    readonly debuggingServerEnabled: boolean
  }

  /**
   * Resolve the daemon network endpoints from the resolved cluster config.
   *
   * AUTHORITY RULE for the two outpost RPC endpoints: an
   * `externalOutposts.<chain>.rpcUrl` WINS whenever it is specified (a mainnet /
   * integrated-testnet outpost whose endpoint no local binding can describe);
   * otherwise the cluster's own BIND governs, exactly as the chain id does — a
   * dev external carries its outpost endpoint in the bind config and omits
   * `rpcUrl`.
   *
   * @param config - The resolved cluster config.
   * @returns The endpoints + debugging sink an operator daemon dials.
   */
  export function networkFromConfig(
    config: ClusterConfig
  ): OperatorDaemonNetwork {
    return {
      ethereumRpcUrl:
        config.externalOutposts?.ethereum.rpcUrl ??
        toURL(config.bind.anvil.port, toDialAddress(config.bind.anvil.address)),
      // External-outpost mode carries the REAL chain id; else the anvil default.
      ethereumChainId:
        config.externalOutposts?.ethereum.chainId ??
        AnvilProcess.DefaultChainId,
      solanaRpcUrl:
        config.externalOutposts?.solana.rpcUrl ??
        toURL(
          config.bind.solana.ports.http,
          toDialAddress(config.bind.solana.address)
        ),
      debuggingServerUrl: toURL(
        config.bind.debuggingServer.port,
        toDialAddress(config.bind.debuggingServer.address)
      ),
      debuggingServerEnabled: config.debuggingServerEnabled !== false
    }
  }

  // ── Step: prepare the daemon's deploy artifacts (filesystem writes) ────────

  /**
   * Prepare the artifacts every operator daemon's command line references:
   * generate `<dataPath>/eth-abis/<Name>.json` (`{contractName, address, abi}`,
   * from the wire-ethereum hardhat artifacts + `outpost-addrs.json`), copy the
   * `liqsol_core` (OPP outpost) IDL to `<dataPath>/solana-idls/`, resolve the SOL program id,
   * and store the typed {@link OperatorDaemonArtifacts}. Runs ONCE, after both
   * outpost deploys, before any operator node starts.
   */
  export function planArtifactPreparation<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(
      actor,
      name,
      description,
      options,
      null,
      runArtifactPreparation
    )
  }

  /** Named runner — write ABI/IDL artifacts + store {@link OperatorDaemonArtifacts}. */
  export async function runArtifactPreparation<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { ethereumPath, solanaPath, dataPath } = ctx.config

    // Deployed ETH outpost addresses (written by the ethereum outpost deploy
    // into THIS cluster's deployments dir — per-run, parallel-safe).
    const addressesFile = Path.join(
      ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
      "outpost-addrs.json"
    )
    Assert.ok(
      Fs.existsSync(addressesFile),
      `ETH outpost addresses not found at ${addressesFile}`
    )
    const ethereumAddresses: Record<string, string> = JSON.parse(
      Fs.readFileSync(addressesFile, "utf-8")
    )

    // ABI files with embedded deployed addresses, so the ethereum client plugin's
    // get_events can filter by contract address (hardhat artifact format).
    const abiDir = mkdirs(Path.join(dataPath, EthereumAbiSubpath))
    const ethereumAbiFiles = EthereumAbiContractNames.map(contractName => {
      // Deployment aliases retain the address/plugin name after Solidity renames.
      const artifactContractName =
        contractName === "BAR" ? "BARV2" : contractName
      const artifactFile = Path.join(
        ethereumPath,
        "artifacts",
        "contracts",
        "outpost",
        `${contractName}.sol`,
        `${artifactContractName}.json`
      )
      if (!Fs.existsSync(artifactFile)) return null
      const artifact = JSON.parse(Fs.readFileSync(artifactFile, "utf-8")),
        abiFile = Path.join(abiDir, `${contractName}.json`)
      Fs.writeFileSync(
        abiFile,
        JSON.stringify(
          {
            contractName,
            address: ethereumAddresses[contractName],
            abi: artifact.abi
          },
          null,
          2
        )
      )
      return abiFile
    }).filter(file => file != null)
    Assert.ok(
      ethereumAbiFiles.length > 0,
      "prepareArtifacts: no ETH outpost ABI artifacts found"
    )

    // SOL program id (from the committed liqsol_core program keypair) + a
    // cluster-local VERBATIM IDL copy so operator nodes read a stable path
    // (nodeop accepts it via --solana-outpost-program-name liqsol_core).
    const solanaProgramId =
      SolanaOutpostProgramTool.assertProgramId(solanaPath).toBase58()

    const idlSource = SolanaOutpostProgramTool.programIdlFile(solanaPath),
      idl = SolanaOutpostProgramTool.readIdl(solanaPath),
      idlInstructionNames = new Set(
        idl.instructions.map(instruction => instruction.name)
      )
    for (const requiredInstruction of RequiredSolanaIdlInstructions) {
      Assert.ok(
        idlInstructionNames.has(requiredInstruction),
        `prepareArtifacts: ${SolanaOutpostProgramTool.ProgramName} IDL at ${idlSource} ` +
          `is missing the '${requiredInstruction}' instruction — wrong or stale IDL?`
      )
    }
    const solanaIdlFile = Path.join(
      mkdirs(Path.join(dataPath, SolanaIdlSubpath)),
      SolanaIdlFilename
    )
    Fs.copyFileSync(idlSource, solanaIdlFile)

    ctx.outputs.set(OperatorDaemonArtifactsKey, {
      ethereumAbiFiles,
      ethereumAddresses,
      solanaProgramId,
      solanaIdlFile
    })
    // The step's payload: the artifact set every operator daemon's command
    // line references (fs writes — no client boundary records these).
    StepExtraRecorder.record({
      client: "harness",
      kind: "artifact",
      text: "address-embedded ETH ABI files + liqsol_core (OPP outpost) IDL prepared for the operator daemons",
      ethereumAbiFiles,
      ethereumAddresses,
      solanaProgramId,
      solanaIdlFile
    })
    ctx.log.info(
      `[operator-daemon] artifacts ready (abis=${ethereumAbiFiles.length}, programId=${solanaProgramId})`
    )
  }

  // ── pure value builders: per-type daemon args ──────────────────────────────

  /** `[flag, value]` pair expansion helper. */
  const pair = (flag: string, value: string): [string, string] => [flag, value]
  /** `--plugin` expansion helper. */
  const pluginArgs = (plugins: readonly string[]): string[] =>
    plugins.flatMap(plugin => pair("--plugin", plugin))

  /** Assert `operator` carries the outpost keys its daemon signs with. */
  function assertOutpostKeys(operator: OperatorAccount): void {
    Assert.ok(
      operator.ethereum != null && operator.solana != null,
      `OperatorDaemonTool: operator ${operator.label} is missing ethereum/solana keys`
    )
  }

  /** The outpost signature-provider + client specs shared by both daemon types. */
  function outpostClientArgs(
    operator: OperatorAccount,
    artifacts: OperatorDaemonArtifacts,
    network: OperatorDaemonNetwork,
    keySourceFor: ClusterConfigProvider.SignatureProviderSourceFor
  ): string[] {
    const ethereumProvider = `eth-${operator.account}`,
      solanaProvider = `sol-${operator.account}`
    return [
      ...pair(
        "--signature-provider",
        KeyGenerator.toSignatureProvider(
          operator.ethereum,
          ethereumProvider,
          keySourceFor(operator.label, KeyType.EM)
        )
      ),
      ...pair(
        "--outpost-ethereum-client",
        [
          EthereumClientId,
          ethereumProvider,
          network.ethereumRpcUrl,
          String(network.ethereumChainId)
        ].join(",")
      ),
      ...artifacts.ethereumAbiFiles.flatMap(file =>
        pair("--ethereum-abi-file", file)
      ),
      ...pair(
        "--signature-provider",
        KeyGenerator.toSignatureProvider(
          operator.solana,
          solanaProvider,
          keySourceFor(operator.label, KeyType.ED)
        )
      ),
      ...pair(
        "--outpost-solana-client",
        [SolanaClientId, solanaProvider, network.solanaRpcUrl].join(",")
      )
    ]
  }

  /**
   * The argv every OPP daemon shares around its role's own flags: irreversible
   * read-mode, the plugin set, the identity's own WIRE signature provider (its
   * `wire` K1, the `account`'s active key), the poll and delivery-timeout
   * tuning, the debugging sink, both outpost clients and the Solana IDL.
   *
   * @param operator - The identity the daemon acts as.
   * @param artifacts - The prepared outpost deploy artifacts.
   * @param network - The endpoints the daemon dials.
   * @param keySourceFor - Where each key's signature provider reads it from.
   * @param roleArgs - The role's own flags, placed after the WIRE provider.
   * @returns The daemon's extra args.
   */
  function daemonArgs(
    operator: OperatorAccount,
    artifacts: OperatorDaemonArtifacts,
    network: OperatorDaemonNetwork,
    keySourceFor: ClusterConfigProvider.SignatureProviderSourceFor,
    roleArgs: readonly string[]
  ): string[] {
    assertOutpostKeys(operator)
    return [
      ...pair(`--${Constants.READ_MODE_OPTION}`, NodeopReadMode.irreversible),
      ...pluginArgs(
        debuggingGatedPlugins(
          BatchOperatorPlugins,
          network.debuggingServerEnabled
        )
      ),
      ...pair(
        "--signature-provider",
        KeyGenerator.toSignatureProvider(
          operator.wire,
          undefined,
          keySourceFor(operator.label, KeyType.K1)
        )
      ),
      ...roleArgs,
      ...pair("--batch-epoch-poll-ms", String(BatchEpochPollMs)),
      ...pair(
        "--batch-delivery-timeout-ms",
        String(scaleTimeoutMs(BatchDeliveryTimeoutMs))
      ),
      ...(network.debuggingServerEnabled
        ? pair("--ext-debugging-server", network.debuggingServerUrl)
        : []),
      ...outpostClientArgs(operator, artifacts, network, keySourceFor),
      // No per-chain outpost flags: the remote OPP contract addresses live on
      // each chain's `sysio.chains` row (seeded by RegistrySteps), and the RPC
      // client for a chain is the one registered under that chain's code.
      ...pair("--solana-idl-file", artifacts.solanaIdlFile),
      // The outpost interface is hosted in liqsol_core since the clean-room
      // rewrite; nodeop's compiled-in default IDL name is opp_outpost.
      ...pair(
        "--solana-outpost-program-name",
        SolanaOutpostProgramTool.ProgramName
      )
    ]
  }

  /**
   * The full extra-arg block for a BATCH OPERATOR daemon: {@link daemonArgs}
   * with the relay's `--batch-operator-account`.
   *
   * @param operator - The batch operator the daemon relays as.
   * @param artifacts - The prepared outpost deploy artifacts.
   * @param network - The endpoints the daemon dials.
   * @param keySourceFor - Where each key's signature provider reads it from.
   * @returns The daemon's extra args.
   */
  export function batchOperatorArgs(
    operator: OperatorAccount,
    artifacts: OperatorDaemonArtifacts,
    network: OperatorDaemonNetwork,
    keySourceFor: ClusterConfigProvider.SignatureProviderSourceFor
  ): string[] {
    Assert.ok(
      operator.type === OperatorType.BATCH,
      `batchOperatorArgs: ${operator.label} is a ${OperatorType[operator.type]}, not a batch operator`
    )
    return daemonArgs(
      operator,
      artifacts,
      network,
      keySourceFor,
      pair("--batch-operator-account", operator.account)
    )
  }

  /**
   * The full extra-arg block for an UNDERWRITER daemon: {@link daemonArgs}
   * with the batch operator plugin's underwriter role and no relay. The node
   * bonds `sysio.synd`'s envelope requests as `underwriter.account@active`,
   * verifying each against its outpost's record, and approves and claims them;
   * it signs with its one WIRE provider, whose key must alone satisfy that
   * permission once the node has synced.
   *
   * @param underwriter - The underwriter identity the daemon bonds as.
   * @param artifacts - The prepared outpost deploy artifacts.
   * @param network - The endpoints the daemon dials.
   * @param keySourceFor - Where each key's signature provider reads it from.
   * @param exposureCaps - One `--batch-underwriter-max-exposure` asset per
   *   token it may bond (e.g. `100.000000000 LIQSOL`); a token with none is
   *   never bonded. Required: asserted here.
   * @returns The daemon's extra args.
   */
  export function underwriterArgs(
    underwriter: OperatorAccount,
    artifacts: OperatorDaemonArtifacts,
    network: OperatorDaemonNetwork,
    keySourceFor: ClusterConfigProvider.SignatureProviderSourceFor,
    exposureCaps: StartDaemonOptions["underwriterExposureCaps"]
  ): string[] {
    Assert.ok(
      underwriter.type === OperatorType.UNDERWRITER,
      `underwriterArgs: ${underwriter.label} is a ${OperatorType[underwriter.type]}, not an underwriter`
    )
    Assert.ok(
      exposureCaps != null && exposureCaps.length > 0,
      `underwriterArgs: ${underwriter.label} has no exposure cap, so it would bond nothing`
    )
    return daemonArgs(underwriter, artifacts, network, keySourceFor, [
      ...pair("--batch-underwriter-account", underwriter.account),
      ...exposureCaps.flatMap(cap =>
        pair("--batch-underwriter-max-exposure", cap)
      )
    ])
  }

  // ── Step: start an operator's daemon (process spawn — its own Step) ───────

  /**
   * Per-role inputs of {@link planDaemonStart}. A role's args builder asserts
   * the ones it needs.
   */
  export interface StartDaemonOptions {
    /**
     * UNDERWRITER — one `--batch-underwriter-max-exposure` asset per token the
     * daemon may bond ({@link underwriterArgs}).
     */
    readonly underwriterExposureCaps?: readonly string[]
  }

  /** Input for {@link planDaemonStart}. */
  export interface StartDaemonInput extends StepInput {
    readonly kind: "OperatorDaemonTool.StartDaemonInput"
    /** The operator's durable key-store label. */
    readonly label: string
    /** The role's own inputs. */
    readonly daemonOptions: StartDaemonOptions
  }

  /**
   * Start a flow-provisioned operator's daemon: a non-producing nodeop carrying
   * the type-matched OPP daemon args ({@link batchOperatorArgs} /
   * {@link underwriterArgs}), composed by `NodeConfig.createAdHoc` (peered to
   * the producer nodes, on {@link BindConfigProvider.claimAdHocPorts}-
   * resolved ports). Required whenever a
   * NON-bootstrapped operator flips ACTIVE — the schedule prefers it over the
   * bootstrapped set, and its group's consensus needs it to relay. Bootstrap
   * operator nodes are planned by `NodeConfig.plan` instead; this Step is for
   * operators provisioned AFTER the plan (flow scenarios).
   *
   * An underwriter's `account` must already hold its key on chain: the plugin
   * picks its signer once, after the node has synced, and shuts the node down
   * when no configured key satisfies the account's permission. This Step
   * returns when the node answers, before that.
   *
   * @param actor - The Report actor.
   * @param name - The Step name.
   * @param description - The Step description.
   * @param options - Step options.
   * @param label - The operator's durable key-store label.
   * @param daemonOptions - The role's own inputs.
   * @returns The Step.
   */
  export function planDaemonStart<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    daemonOptions: StartDaemonOptions = {}
  ): ClusterBuildStep<C, StartDaemonInput> {
    return ClusterBuildStep.create<C, StartDaemonInput>(
      actor,
      name,
      description,
      options,
      { kind: "OperatorDaemonTool.StartDaemonInput", label, daemonOptions },
      runDaemonStart
    )
  }

  /** Named runner — ONE nodeop spawn: the operator's daemon node. */
  export async function runDaemonStart<C extends ClusterBuildContext>(
    ctx: C,
    input: StartDaemonInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const nodeName = NodeConfig.adHocNodeName(input.label)
    if (ctx.processManager.get(nodeName) != null) return

    const operator = ctx.keyStore.assertOperator(input.label),
      artifacts = ctx.outputs.assert(OperatorDaemonArtifactsKey),
      network = networkFromConfig(ctx.config),
      keySourceFor = ClusterConfigProvider.signatureProviderSource(ctx.config),
      extraArgs = match(operator.type)
        .with(OperatorType.BATCH, () =>
          batchOperatorArgs(operator, artifacts, network, keySourceFor)
        )
        .with(OperatorType.UNDERWRITER, () =>
          underwriterArgs(
            operator,
            artifacts,
            network,
            keySourceFor,
            input.daemonOptions.underwriterExposureCaps
          )
        )
        .otherwise(() => {
          throw new Error(
            `startDaemon: ${input.label} is a ${OperatorType[operator.type]}, not an OPP operator`
          )
        })

    const ports = BindConfigProvider.claimAdHocPorts(
      ctx.config.bind,
      input.label
    )
    // startWithRecovery (not bare create+start): a flow rerun reuses the
    // daemon's data dir, so an unclean prior stop leaves a dirty chainbase
    // this launch must recover from, same as the planned-node paths.
    await NodeopProcess.startWithRecovery(ctx.processManager, {
      node: NodeConfig.createAdHoc(ctx.config, operator, ports),
      operators: [operator],
      extraArgs
    })
    ctx.log.info(
      `[operator-daemon] ${input.label} (${operator.account}) daemon up (${nodeName}, http=${ports.http})`
    )
  }
}
