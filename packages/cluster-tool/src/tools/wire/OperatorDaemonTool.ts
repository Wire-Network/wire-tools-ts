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
import type {
  BindConfigNodeopPorts,
  ClusterConfig
} from "@wireio/cluster-tool-shared"
import { OperatorType } from "@wireio/opp-typescript-models"
import { match } from "ts-pattern"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { WireClient } from "../../clients/wire/WireClient.js"
import { BindConfigProvider } from "../../config/BindConfigProvider.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { NodeConfig, NodeRole } from "../../config/NodeConfig.js"
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
import { AnvilEthereumTransactionPolicy } from "../ethereum/EthereumTransactionPolicy.js"
import { SolanaOutpostProgramTool } from "../solana/SolanaOutpostProgramTool.js"
import { mkdirs } from "../../utils/fsUtils.js"
import { scaleTimeoutMs } from "../../utils/asyncUtils.js"
import { Localhost, toURL } from "../../utils/netUtils.js"

export namespace OperatorDaemonTool {
  // ── plugin sets ────────────────────────────────────────────────────────────

  /** Plugins a batch-operator daemon loads. */
  export const BatchOperatorPlugins = [
    "sysio::batch_operator_plugin",
    "sysio::external_debugging_plugin",
    "sysio::outpost_ethereum_client_plugin",
    "sysio::outpost_solana_client_plugin",
    "sysio::cron_plugin"
  ] as const

  /** Plugins an underwriter daemon loads. */
  export const UnderwriterPlugins = [
    "sysio::underwriter_plugin",
    "sysio::outpost_ethereum_client_plugin",
    "sysio::outpost_solana_client_plugin",
    "sysio::external_debugging_plugin",
    "sysio::cron_plugin"
  ] as const

  // ── daemon tuning + protocol constants ────────────────────────────────────

  /** batch_operator_plugin epoch poll interval (ms). */
  export const BatchEpochPollMs = 15_000
  /** batch_operator_plugin delivery timeout (ms; nominal — scaled at arg build). */
  export const BatchDeliveryTimeoutMs = 30_000
  /**
   * underwriter_plugin outpost action timeout (ms; nominal — scaled at arg
   * build). Mirrors the plugin default; passed EXPLICITLY so the flow timing
   * scale reaches it: on a starved shared-host validator a commit tx can
   * take >15s to confirm, and the plugin then re-submits every scan cycle
   * forever (run 28700849707: uwreq 35's SOL leg timed out at 15s per
   * attempt for 12 minutes while the ETH leg sat confirmed).
   */
  export const UnderwriterActionTimeoutMs = 30_000
  /** The single ethereum outpost client id every plugin arg references. */
  export const EthereumClientId = "eth-default"
  /** The single solana outpost client id every plugin arg references. */
  export const SolanaClientId = "sol-default"
  /** The `sysio.chains` codename keying the ETH outpost wiring specs. */
  export const EthereumChainCodename = "ETHEREUM"
  /** The `sysio.chains` codename keying the SOL outpost wiring specs. */
  export const SolanaChainCodename = "SOLANA"
  /** ETH source-deposit function the underwriter verifies before committing. */
  export const EthereumSourceDepositFunction = "requestSwap"
  /** SOL source-deposit instruction the underwriter verifies before committing. */
  export const SolanaSourceDepositInstruction = "request_swap"
  /** SOL inbound-delivery instruction the batch operator invokes. */
  export const SolanaEpochInInstruction = "epoch_in"
  /** SOL underwriter-commit instruction. */
  export const SolanaCommitUnderwriteInstruction = "commit_underwrite"
  /**
   * OPP outpost instructions the daemons invoke — asserted present in the
   * copied IDL so a wrong or stale IDL fails at artifact preparation, not at
   * the first delivery.
   */
  export const RequiredSolanaIdlInstructions = [
    SolanaEpochInInstruction,
    SolanaCommitUnderwriteInstruction,
    SolanaSourceDepositInstruction
  ] as const
  /** OPP outpost contracts whose ABIs (with embedded addresses) the plugins load. */
  export const EthereumAbiContractNames = [
    "OPP",
    "OPPInbound",
    "BAR",
    "ReserveManager",
    "OperatorRegistry"
  ] as const
  /** Cluster-data subpath holding the generated `{contractName, address, abi}` files. */
  export const EthereumAbiSubpath = "eth-abis"
  /** Cluster-data filename for the generated SEC-131 Anvil transaction policy. */
  export const EthereumTransactionPolicyFilename =
    "ethereum-transaction-policy.json"
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
  }

  /** Resolve the daemon network endpoints from the resolved cluster config. */
  export function networkFromConfig(
    config: ClusterConfig
  ): OperatorDaemonNetwork {
    return {
      ethereumRpcUrl: toURL(config.bind.anvil.port, Localhost),
      ethereumChainId: AnvilProcess.DefaultChainId,
      solanaRpcUrl: toURL(config.bind.solana.ports.http, Localhost),
      debuggingServerUrl: toURL(config.bind.debuggingServer.port, Localhost)
    }
  }

  // ── Step: prepare the daemon's deploy artifacts (filesystem writes) ────────

  /**
   * Prepare the artifacts every operator daemon's command line references:
   * generate `<dataPath>/eth-abis/<Name>.json` (`{contractName, address, abi}`,
   * from the wire-ethereum hardhat artifacts + `outpost-addrs.json`), copy the
   * `liqsol_core` (OPP outpost) IDL to `<dataPath>/solana-idls/`, generate the
   * SEC-131 Anvil transaction-policy file, resolve the SOL program id, and
   * store the typed {@link OperatorDaemonArtifacts}. Runs ONCE, after both
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
      const artifactFile = Path.join(
        ethereumPath,
        "artifacts",
        "contracts",
        "outpost",
        `${contractName}.sol`,
        `${contractName}.json`
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

    // SEC-131 fails closed when an Ethereum signing client has no matching
    // policy. Generate the file from typed Anvil-only limits on every create /
    // run so existing cluster state needs no schema migration.
    const ethereumTransactionPolicyFile = Path.join(
        dataPath,
        EthereumTransactionPolicyFilename
      ),
      ethereumTransactionPolicy = AnvilEthereumTransactionPolicy.create(
        EthereumClientId,
        AnvilProcess.DefaultChainId
      )
    Fs.writeFileSync(
      ethereumTransactionPolicyFile,
      JSON.stringify(ethereumTransactionPolicy, null, 2)
    )

    ctx.outputs.set(OperatorDaemonArtifactsKey, {
      ethereumAbiFiles,
      ethereumAddresses,
      ethereumTransactionPolicyFile,
      solanaProgramId,
      solanaIdlFile
    })
    // The step's payload: the artifact set every operator daemon's command
    // line references (fs writes — no client boundary records these).
    StepExtraRecorder.record({
      client: "harness",
      kind: "artifact",
      text: "address-embedded ETH ABIs + SEC-131 Anvil policy + liqsol_core IDL prepared for the operator daemons",
      ethereumAbiFiles,
      ethereumAddresses,
      ethereumTransactionPolicyFile,
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
      `OperatorDaemonTool: operator ${operator.account} is missing ethereum/solana keys`
    )
  }

  /** The outpost signature-provider + client specs shared by both daemon types. */
  function outpostClientArgs(
    operator: OperatorAccount,
    artifacts: OperatorDaemonArtifacts,
    network: OperatorDaemonNetwork
  ): string[] {
    const ethereumProvider = `eth-${operator.account}`,
      solanaProvider = `sol-${operator.account}`
    return [
      ...pair(
        "--signature-provider",
        KeyGenerator.toSignatureProvider(operator.ethereum, ethereumProvider)
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
      ...pair(
        "--outpost-ethereum-transaction-policy-file",
        artifacts.ethereumTransactionPolicyFile
      ),
      ...artifacts.ethereumAbiFiles.flatMap(file =>
        pair("--ethereum-abi-file", file)
      ),
      ...pair(
        "--signature-provider",
        KeyGenerator.toSignatureProvider(operator.solana, solanaProvider)
      ),
      ...pair(
        "--outpost-solana-client",
        [SolanaClientId, solanaProvider, network.solanaRpcUrl].join(",")
      )
    ]
  }

  /**
   * The full extra-arg block for a BATCH OPERATOR daemon: read-mode + plugins +
   * the operator's own WIRE signature provider (its unique `wire` K1 — the
   * account's active key) + batch plugin config + both outpost client specs.
   */
  export function batchOperatorArgs(
    operator: OperatorAccount,
    artifacts: OperatorDaemonArtifacts,
    network: OperatorDaemonNetwork
  ): string[] {
    Assert.ok(
      operator.type === OperatorType.BATCH,
      `batchOperatorArgs: ${operator.account} is a ${OperatorType[operator.type]}, not a batch operator`
    )
    assertOutpostKeys(operator)
    return [
      ...pair("--read-mode", WireClient.FinalityType.irreversible),
      ...pluginArgs(BatchOperatorPlugins),
      ...pair(
        "--signature-provider",
        KeyGenerator.toSignatureProvider(operator.wire)
      ),
      ...pair("--batch-enabled", "true"),
      ...pair("--batch-operator-account", operator.account),
      ...pair("--batch-epoch-poll-ms", String(BatchEpochPollMs)),
      ...pair(
        "--batch-delivery-timeout-ms",
        String(scaleTimeoutMs(BatchDeliveryTimeoutMs))
      ),
      ...pair("--ext-debugging-server", network.debuggingServerUrl),
      ...outpostClientArgs(operator, artifacts, network),
      // Per-chain outpost bindings (repeatable CSV specs; replaced the removed
      // --batch-eth-{client-id,opp-addr,opp-inbound-addr} / --batch-sol-program-id —
      // the EVM RPC client is auto-selected by matching the chains row's
      // external_chain_id against the --outpost-ethereum-client chain ids):
      //   EVM: <chain_code>,<opp_addr>,<opp_inbound_addr>
      //   SVM: <chain_code>,<opp_outpost_program_id>
      ...pair(
        "--batch-outpost",
        [
          EthereumChainCodename,
          assertAddress(artifacts, "OPP"),
          assertAddress(artifacts, "OPPInbound")
        ].join(",")
      ),
      ...pair(
        "--batch-outpost",
        [SolanaChainCodename, artifacts.solanaProgramId].join(",")
      ),
      ...pair("--batch-sol-client-id", SolanaClientId),
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
   * The full extra-arg block for an UNDERWRITER daemon: read-mode + plugins + the
   * operator's WIRE signature provider + underwriter plugin config + both outpost
   * client specs + the source-deposit verification targets.
   */
  export function underwriterArgs(
    operator: OperatorAccount,
    artifacts: OperatorDaemonArtifacts,
    network: OperatorDaemonNetwork
  ): string[] {
    Assert.ok(
      operator.type === OperatorType.UNDERWRITER,
      `underwriterArgs: ${operator.account} is a ${OperatorType[operator.type]}, not an underwriter`
    )
    assertOutpostKeys(operator)
    return [
      ...pair("--read-mode", WireClient.FinalityType.irreversible),
      ...pluginArgs(UnderwriterPlugins),
      ...pair(
        "--signature-provider",
        KeyGenerator.toSignatureProvider(operator.wire)
      ),
      ...pair("--underwriter-enabled", "true"),
      ...pair("--underwriter-account", operator.account),
      ...pair(
        "--underwriter-action-timeout-ms",
        String(scaleTimeoutMs(UnderwriterActionTimeoutMs))
      ),
      ...pair("--ext-debugging-server", network.debuggingServerUrl),
      ...outpostClientArgs(operator, artifacts, network),
      // Per-chain outpost wiring (repeatable CSV specs; replaced the removed
      // --underwriter-eth-opreg-addr / --underwriter-{eth,sol}-client-id):
      //   EVM: <chain_code>,<client_id>,<operator_registry_addr>,<source_deposit_contract_addr>
      //   SVM: <chain_code>,<client_id>,<opp_outpost_program_id>
      ...pair(
        "--underwriter-eth-outpost",
        [
          EthereumChainCodename,
          EthereumClientId,
          assertAddress(artifacts, "OperatorRegistry"),
          assertAddress(artifacts, "ReserveManager")
        ].join(",")
      ),
      ...pair(
        "--underwriter-sol-outpost",
        [SolanaChainCodename, SolanaClientId, artifacts.solanaProgramId].join(
          ","
        )
      ),
      ...pair(
        "--underwriter-eth-source-deposit-function",
        EthereumSourceDepositFunction
      ),
      ...pair(
        "--underwriter-sol-source-deposit-instruction",
        SolanaSourceDepositInstruction
      ),
      ...pair("--solana-idl-file", artifacts.solanaIdlFile),
      // The outpost interface is hosted in liqsol_core since the clean-room
      // rewrite; nodeop's compiled-in default IDL name is opp_outpost.
      ...pair(
        "--solana-outpost-program-name",
        SolanaOutpostProgramTool.ProgramName
      )
    ]
  }

  /** Assert a deployed ETH outpost address is present in the artifacts. */
  function assertAddress(
    artifacts: OperatorDaemonArtifacts,
    contractName: string
  ): string {
    const address = artifacts.ethereumAddresses[contractName]
    Assert.ok(
      address != null && address.length > 0,
      `OperatorDaemonTool: ${contractName} address missing from outpost-addrs.json`
    )
    return address
  }

  // ── Step: start an operator's daemon (process spawn — its own Step) ───────

  /** Preferred HTTP port for an ad-hoc (flow-provisioned) operator daemon. */
  export const PreferredDaemonHttpPort = 8988
  /** Preferred p2p port for an ad-hoc (flow-provisioned) operator daemon. */
  export const PreferredDaemonP2pPort = 9976

  /** The process label + node-dir name for an operator's daemon. */
  export function daemonNodeName(account: string): string {
    return `node_${account}`
  }

  /** Input for {@link planDaemonStart}. */
  export interface StartDaemonInput extends StepInput {
    readonly kind: "OperatorDaemonTool.StartDaemonInput"
    readonly account: string
  }

  /**
   * Start a flow-provisioned operator's daemon: a non-producing nodeop carrying
   * the type-matched OPP daemon args ({@link batchOperatorArgs} /
   * {@link underwriterArgs}), peered to the producer nodes, on
   * {@link BindConfigProvider.findAvailable}-resolved ports. Required whenever a
   * NON-bootstrapped operator flips ACTIVE — the schedule prefers it over the
   * bootstrapped set, and its group's consensus needs it to relay. Bootstrap
   * operator nodes are planned by `NodeConfig.plan` instead; this Step is for
   * operators provisioned AFTER the plan (flow scenarios).
   */
  export function planDaemonStart<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string
  ): ClusterBuildStep<C, StartDaemonInput> {
    return ClusterBuildStep.create<C, StartDaemonInput>(
      actor,
      name,
      description,
      options,
      { kind: "OperatorDaemonTool.StartDaemonInput", account },
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
    const nodeName = daemonNodeName(input.account)
    if (ctx.processManager.get(nodeName) != null) return

    const operator = ctx.keyStore.assertOperator(input.account),
      artifacts = ctx.outputs.assert(OperatorDaemonArtifactsKey),
      network = networkFromConfig(ctx.config),
      daemonArgs = match(operator.type)
        .with(OperatorType.BATCH, () =>
          batchOperatorArgs(operator, artifacts, network)
        )
        .with(OperatorType.UNDERWRITER, () =>
          underwriterArgs(operator, artifacts, network)
        )
        .otherwise(() => {
          throw new Error(
            `startDaemon: ${input.account} is a ${OperatorType[operator.type]}, not an OPP operator`
          )
        })

    const ports: BindConfigNodeopPorts = {
      http: await BindConfigProvider.findAvailable(PreferredDaemonHttpPort),
      p2p: await BindConfigProvider.findAvailable(PreferredDaemonP2pPort)
    }
    // startWithRecovery (not bare create+start): a flow rerun reuses the
    // daemon's data dir, so an unclean prior stop leaves a dirty chainbase
    // this launch must recover from, same as the planned-node paths.
    await NodeopProcess.startWithRecovery(ctx.processManager, {
      node: daemonNodeConfig(ctx.config, operator, ports),
      operator,
      extraArgs: daemonArgs
    })
    ctx.log.info(
      `[operator-daemon] ${input.account} daemon up (${nodeName}, http=${ports.http})`
    )
  }

  /** Topology index for ad-hoc daemon nodes (not part of `NodeConfig.plan`). */
  const AdHocDaemonNodeIndex = -1

  /**
   * Compose the daemon's {@link NodeConfig}: a non-producing operator node named
   * for the account, peered to every producer node, on the resolved `ports`.
   */
  function daemonNodeConfig(
    config: ClusterConfig,
    operator: OperatorAccount,
    ports: BindConfigNodeopPorts
  ): NodeConfig {
    const isBatchOperator = operator.type === OperatorType.BATCH,
      producerPeers = config.bind.nodeop.ports.producers.map(
        producerPorts => `${Localhost}:${producerPorts.p2p}`
      )
    return new NodeConfig(
      config,
      NodeRole.operator,
      AdHocDaemonNodeIndex,
      daemonNodeName(operator.account),
      ports,
      [],
      producerPeers,
      isBatchOperator ? operator.account : null,
      isBatchOperator ? null : operator.account
    )
  }
}
