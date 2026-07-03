/**
 * OperatorDaemonTool — everything an OPERATOR nodeop daemon (batch operator /
 * underwriter) needs beyond the base node args: the OPP plugin set, the WIRE +
 * outpost `--signature-provider` specs (from the operator's {@link OperatorAccount}
 * in `ctx.keyStore`), the outpost client specs, and the deploy artifacts (ETH ABI
 * files with embedded addresses, the SOL program id + IDL).
 *
 * {@link prepareArtifacts} is a Step (run once, after both outpost deploys) that
 * writes the cluster-local artifact files and stores the typed
 * {@link OperatorDaemonArtifacts}; {@link batchOperatorArgs} /
 * {@link underwriterArgs} are PURE value builders the operator-node start runner
 * composes into `NodeopProcess` extra args.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { Keypair } from "@solana/web3.js"
import { OperatorType } from "@wireio/opp-typescript-models"
import { match } from "ts-pattern"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { WireClient } from "../../clients/wire/WireClient.js"
import { BindConfig, type BindConfigNodeopPorts } from "../../config/BindConfig.js"
import type { ClusterConfig } from "../../config/ClusterConfig.js"
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
import { mkdirs } from "../../utils/fsUtils.js"
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
  /** batch_operator_plugin delivery timeout (ms). */
  export const BatchDeliveryTimeoutMs = 15_000
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
  /** Cluster-data subpath holding the copied `opp_outpost.json` IDL. */
  export const SolanaIdlSubpath = "solana-idls"
  /** The opp-outpost IDL filename. */
  export const SolanaIdlFilename = "opp_outpost.json"

  // ── network endpoints the daemon dials ─────────────────────────────────────

  /** The chain endpoints + debugging sink an operator daemon dials. */
  export interface OperatorDaemonNetwork {
    readonly ethereumRpcUrl: string
    readonly ethereumChainId: number
    readonly solanaRpcUrl: string
    readonly debuggingServerUrl: string
  }

  /** Resolve the daemon network endpoints from the resolved cluster config. */
  export function networkFromConfig(config: ClusterConfig): OperatorDaemonNetwork {
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
   * `opp_outpost` IDL to `<dataPath>/solana-idls/`, resolve the SOL program id,
   * and store the typed {@link OperatorDaemonArtifacts}. Runs ONCE, after both
   * outpost deploys, before any operator node starts.
   */
  export function prepareArtifacts<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep<C, null> {
    return ClusterBuildStep.create<C, null>(actor, name, description, options, null, runPrepareArtifacts)
  }

  /** Named runner — write ABI/IDL artifacts + store {@link OperatorDaemonArtifacts}. */
  export async function runPrepareArtifacts<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { ethereumPath, solanaPath, dataPath } = ctx.config

    // Deployed ETH outpost addresses (written by the ethereum outpost deploy
    // into THIS cluster's deployments dir — per-run, parallel-safe).
    const addressesFile = Path.join(
      ctx.config.ethereumDeploymentsPath,
      "outpost-addrs.json"
    )
    Assert.ok(Fs.existsSync(addressesFile), `ETH outpost addresses not found at ${addressesFile}`)
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
          { contractName, address: ethereumAddresses[contractName], abi: artifact.abi },
          null,
          2
        )
      )
      return abiFile
    }).filter(file => file != null)
    Assert.ok(ethereumAbiFiles.length > 0, "prepareArtifacts: no ETH outpost ABI artifacts found")

    // SOL program id (from the program keypair) + a cluster-local IDL copy so
    // operator nodes read a stable path.
    const programKeypairFile = Path.join(solanaPath, "wallets", "opp-outpost-keypair.json")
    Assert.ok(
      Fs.existsSync(programKeypairFile),
      `opp-outpost program keypair not found at ${programKeypairFile}`
    )
    const keypairBytes = Uint8Array.from(
        JSON.parse(Fs.readFileSync(programKeypairFile, "utf8"))
      ),
      solanaProgramId = Keypair.fromSecretKey(keypairBytes).publicKey.toBase58()

    const idlSource = Path.join(solanaPath, "target", "idl", SolanaIdlFilename)
    Assert.ok(
      Fs.existsSync(idlSource),
      `opp-outpost IDL missing: ${idlSource} (run 'anchor build -p opp-outpost')`
    )
    const solanaIdlFile = Path.join(mkdirs(Path.join(dataPath, SolanaIdlSubpath)), SolanaIdlFilename)
    Fs.copyFileSync(idlSource, solanaIdlFile)

    ctx.outputs.set(OperatorDaemonArtifactsKey, {
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
        [EthereumClientId, ethereumProvider, network.ethereumRpcUrl, String(network.ethereumChainId)].join(",")
      ),
      ...artifacts.ethereumAbiFiles.flatMap(file => pair("--ethereum-abi-file", file)),
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
      ...pair("--signature-provider", KeyGenerator.toSignatureProvider(operator.wire)),
      ...pair("--batch-enabled", "true"),
      ...pair("--batch-operator-account", operator.account),
      ...pair("--batch-epoch-poll-ms", String(BatchEpochPollMs)),
      ...pair("--batch-delivery-timeout-ms", String(BatchDeliveryTimeoutMs)),
      ...pair("--ext-debugging-server", network.debuggingServerUrl),
      ...outpostClientArgs(operator, artifacts, network),
      ...pair("--batch-eth-opp-addr", assertAddress(artifacts, "OPP")),
      ...pair("--batch-eth-opp-inbound-addr", assertAddress(artifacts, "OPPInbound")),
      ...pair("--batch-eth-client-id", EthereumClientId),
      ...pair("--batch-sol-client-id", SolanaClientId),
      ...pair("--solana-idl-file", artifacts.solanaIdlFile),
      ...pair("--batch-sol-program-id", artifacts.solanaProgramId)
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
      ...pair("--signature-provider", KeyGenerator.toSignatureProvider(operator.wire)),
      ...pair("--underwriter-enabled", "true"),
      ...pair("--underwriter-account", operator.account),
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
        [SolanaChainCodename, SolanaClientId, artifacts.solanaProgramId].join(",")
      ),
      ...pair("--underwriter-eth-source-deposit-function", EthereumSourceDepositFunction),
      ...pair("--underwriter-sol-source-deposit-instruction", SolanaSourceDepositInstruction),
      ...pair("--solana-idl-file", artifacts.solanaIdlFile)
    ]
  }

  /** Assert a deployed ETH outpost address is present in the artifacts. */
  function assertAddress(artifacts: OperatorDaemonArtifacts, contractName: string): string {
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

  /** Input for {@link startDaemon}. */
  export interface StartDaemonInput extends StepInput {
    readonly kind: "OperatorDaemonTool.StartDaemonInput"
    readonly account: string
  }

  /**
   * Start a flow-provisioned operator's daemon: a non-producing nodeop carrying
   * the type-matched OPP daemon args ({@link batchOperatorArgs} /
   * {@link underwriterArgs}), peered to the producer nodes, on
   * {@link BindConfig.findAvailable}-resolved ports. Required whenever a
   * NON-bootstrapped operator flips ACTIVE — the schedule prefers it over the
   * bootstrapped set, and its group's consensus needs it to relay. Bootstrap
   * operator nodes are planned by `NodeConfig.plan` instead; this Step is for
   * operators provisioned AFTER the plan (flow scenarios).
   */
  export function startDaemon<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runStartDaemon
    )
  }

  /** Named runner — ONE nodeop spawn: the operator's daemon node. */
  export async function runStartDaemon<C extends ClusterBuildContext>(
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
        .with(OperatorType.BATCH, () => batchOperatorArgs(operator, artifacts, network))
        .with(OperatorType.UNDERWRITER, () => underwriterArgs(operator, artifacts, network))
        .otherwise(() => {
          throw new Error(
            `startDaemon: ${input.account} is a ${OperatorType[operator.type]}, not an OPP operator`
          )
        })

    const ports: BindConfigNodeopPorts = {
      http: await BindConfig.findAvailable(PreferredDaemonHttpPort),
      p2p: await BindConfig.findAvailable(PreferredDaemonP2pPort)
    }
    const nodeop = await NodeopProcess.create(ctx.processManager, {
      node: daemonNodeConfig(ctx.config, operator, ports),
      operator,
      extraArgs: daemonArgs
    })
    await nodeop.start()
    ctx.log.info(`[operator-daemon] ${input.account} daemon up (${nodeName}, http=${ports.http})`)
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
