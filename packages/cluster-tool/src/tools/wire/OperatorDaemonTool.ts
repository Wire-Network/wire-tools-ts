/**
 * OperatorDaemonTool — everything a batch-operator nodeop daemon needs beyond the base
 * node args: the OPP plugin set, the WIRE + outpost `--signature-provider` specs (from
 * the operator's {@link OperatorAccount} in `ctx.keyStore`), the outpost client specs,
 * the optional underwriter role of the same plugin, and the deploy artifacts (ETH ABI
 * files with embedded addresses, the SOL program id + IDL).
 *
 * {@link planArtifactPreparation} is a Step (run once, after both outpost deploys) that
 * writes the cluster-local artifact files and stores the typed
 * {@link OperatorDaemonArtifacts}; {@link batchOperatorArgs} is the PURE value builder
 * the operator-node start runner composes into `NodeopProcess` extra args.
 */

import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { Either } from "@3fv/prelude-ts"
import type * as anchor from "@coral-xyz/anchor"
import { ethers } from "ethers"
import { identity } from "lodash"
import { match, P } from "ts-pattern"
import {
  type ClusterConfig,
  type EthereumReadConfirmationConfig,
  ExternalOutpostConfig,
  NodeopReadMode
} from "@wireio/cluster-tool-shared"
import { OperatorType, type TokenAmount } from "@wireio/opp-typescript-models"
import { Asset, KeyType, SlugName } from "@wireio/sdk-core"
import { NestedError } from "@wireio/shared"
import { Constants } from "../../Constants.js"
import { KeyGenerator } from "../../clients/wire/KeyGenerator.js"
import { BindConfigProvider } from "../../config/BindConfigProvider.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { EthereumReadConfirmationConfigProvider } from "../../config/EthereumReadConfirmationConfigProvider.js"
import { NodeConfig } from "../../config/NodeConfig.js"
import { AnvilProcess } from "../../cluster/processes/AnvilProcess.js"
import { NodeopProcess } from "../../cluster/processes/NodeopProcess.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { EthereumOutpostBootstrapper } from "../../orchestration/ethereum/EthereumOutpostBootstrapper.js"
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

  // ── underwriter role on the batch-operator daemon ─────────────────────────

  /**
   * The shadow asset a configured exposure cap renders as: its base units at the liq-token
   * precision, in its token's symbol (`10.000000000 LIQSOL`).
   *
   * @param cap - A `batchOperatorUnderwriting.maxExposure` entry.
   * @return The asset.
   */
  export function exposureAsset(cap: TokenAmount): Asset {
    return Asset.fromUnits(
      cap.amount.toString(),
      Constants.liqSymbol(SlugName.toString(Number(cap.tokenCode)))
    )
  }

  /** What a batch operator underwrites with, beyond its own account and key. */
  export interface BatchUnderwriting {
    /**
     * The `--batch-underwriter-max-exposure` caps, one asset per shadow token underwritten.
     * Empty means the node does not run the underwriter role: with no cap the plugin would
     * underwrite nothing.
     */
    readonly maxExposure: readonly Asset[]
  }

  /** A relay-only batch operator: no underwriter role. */
  export const NoBatchUnderwriting: BatchUnderwriting = { maxExposure: [] }

  /**
   * The underwriting a cluster's batch operators run: its configured caps when
   * `batchOperatorUnderwriting` is set, else {@link NoBatchUnderwriting}. Funded or not,
   * every operator runs the role; an unfunded one holds nothing to bond.
   *
   * @param config - The resolved cluster config.
   * @return The underwriting.
   */
  export function underwritingFromConfig(
    config: ClusterConfig
  ): BatchUnderwriting {
    return config.batchOperatorUnderwriting == null
      ? NoBatchUnderwriting
      : {
          maxExposure:
            config.batchOperatorUnderwriting.maxExposure.map(exposureAsset)
        }
  }

  /** `plugins` with the external-debugging sink removed when the server is off. */
  const debuggingGatedPlugins = (
    plugins: readonly string[],
    debuggingServerEnabled: boolean
  ): readonly string[] =>
    debuggingServerEnabled
      ? plugins
      : plugins.filter(plugin => plugin !== ExternalDebuggingPlugin)

  // ── daemon tuning + protocol constants ────────────────────────────────────

  /**
   * batch_operator_plugin epoch poll interval (ms): one plugin pass. With the underwriter role
   * on, it is the role's spacing while a request is in play, so paying a bond back takes two
   * passes after its challenge window opens, one to approve and one to claim.
   */
  export const BatchEpochPollMs = 15_000
  /**
   * The underwriter role's crank spacing while no envelope request is in play — the
   * plugin's own `UNDERWRITER_IDLE_CRANK_INTERVAL = fc::minutes(5)`
   * (wire-sysio `plugins/batch_operator_plugin/src/batch_operator_plugin.cpp`), not a flag
   * this tool renders. Kept beside {@link BatchEpochPollMs} because both bound how soon the
   * daemon acts; only `sysio.synd::crank` issues a request, so a syndication that arrives
   * while nothing is in play can wait this long for one.
   */
  export const UnderwriterIdleCrankIntervalMs = 300_000
  /**
   * Outpost RPC client ids ARE the chain codes.
   *
   * Both operator daemons look a chain's RPC client up under that chain's
   * `sysio.chains` code, so the id passed to `--outpost-{ethereum,solana}-client`
   * must be the codename and nothing else. A client registered under any other
   * id is invisible to them, and a batch operator that cannot reach an active
   * chain shuts down rather than relaying a partial epoch.
   */
  export const EthereumClientId = Constants.ETHEREUM_CHAIN_CODENAME
  /** See {@link EthereumClientId} — the SOL client id is likewise the chain code. */
  export const SolanaClientId = Constants.SOLANA_CHAIN_CODENAME
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
  /**
   * One named field of an Anchor IDL struct or instruction — Anchor's `IdlField`, derived from
   * the `Idl` its package root exports (the root does not export `IdlField` itself).
   */
  export type SolanaIdlField = anchor.Idl["instructions"][number]["args"][number]
  /** The Solana outpost account the relay reads the outbound backlog's message count from. */
  export const SolanaOutboundBufferAccount = "OutboundMessageBuffer"
  /** The Solana outpost account the relay reads the latest emitted outbound envelope from. */
  export const SolanaLatestOutboundEnvelopeAccount = "LatestOutboundEnvelope"
  /**
   * The leading fields of each Solana outpost account the relay decodes at fixed byte offsets, in
   * declaration order: the backlog's message count `attestation_count` at byte 20 of
   * {@link SolanaOutboundBufferAccount}, and the latest emitted envelope's `epoch_index` at byte 9
   * of {@link SolanaLatestOutboundEnvelopeAccount}, each after the 8-byte account discriminator.
   * Asserted in the copied IDL so a wrong or stale IDL fails at artifact preparation, before any
   * daemon starts.
   */
  export const RequiredSolanaAccountLeadingFields: Readonly<
    Record<string, readonly SolanaIdlField[]>
  > = {
    [SolanaOutboundBufferAccount]: [
      { name: "next_swap_id", type: "u64" },
      { name: "used_data_bytes", type: "u32" },
      { name: "attestation_count", type: "u16" }
    ],
    [SolanaLatestOutboundEnvelopeAccount]: [
      { name: "bump", type: "u8" },
      { name: "epoch_index", type: "u32" }
    ]
  }
  /** The per-epoch Solana outpost tally the relay finds its own recorded delivery in. */
  export const SolanaEpochDeliveriesAccount = "EpochDeliveries"
  /** {@link SolanaEpochDeliveriesAccount}'s field of recorded deliveries: a Vec of records. */
  export const SolanaEpochDeliveriesRecordsField = "deliveries"
  /**
   * The field each record of {@link SolanaEpochDeliveriesRecordsField} must declare: the
   * deliverer's key, which the relay compares with its own to send nothing for a delivery the
   * outpost already recorded. The batch-operator role refuses to boot without it; asserted in the
   * copied IDL so a stale IDL fails at artifact preparation.
   */
  export const RequiredSolanaDeliveryRecordField = {
    name: "operator",
    type: "pubkey"
  } as const satisfies SolanaIdlField
  /** OPP outpost contracts whose ABIs (with embedded addresses) the plugins load. */
  export const EthereumAbiContractNames =
    ExternalOutpostConfig.RequiredOutpostContractNames
  /** One of {@link EthereumAbiContractNames}. */
  export type EthereumAbiContractName = (typeof EthereumAbiContractNames)[number]
  /**
   * The functions each daemon ABI must declare, by contract — asserted in the hardhat artifact
   * before its ABI file is written, so a wire-ethereum build without them fails at artifact
   * preparation rather than at daemon start. The Ethereum client refuses an OPP ABI without
   * `pendingOutbound()`, the view the relay reads the outbound backlog from.
   */
  export const RequiredEthereumAbiFunctions: Readonly<
    Record<EthereumAbiContractName, readonly string[]>
  > = {
    OPP: ["pendingOutbound"],
    OPPInbound: [],
    BAR: []
  }
  /** Cluster-data subpath holding the generated `{contractName, address, abi}` files. */
  export const EthereumAbiSubpath = "eth-abis"
  /** Cluster-data subpath holding the copied OPP outpost IDL. */
  export const SolanaIdlSubpath = "solana-idls"
  /** The OPP outpost IDL filename (cluster-local verbatim copy). */
  export const SolanaIdlFilename = `${SolanaOutpostProgramTool.ProgramName}.json`

  // ── network endpoints the daemon dials ─────────────────────────────────────

  /**
   * The chain endpoints + debugging sink an operator daemon dials, and the read
   * confirmation its Ethereum client reads the outpost at.
   */
  export interface OperatorDaemonNetwork {
    readonly ethereumRpcUrl: string
    readonly ethereumChainId: number
    readonly ethereumRead: EthereumReadConfirmationConfig
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
      ethereumRead: config.ethereumRead,
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
   * Prepare the artifacts every operator daemon's command line references,
   * built from source: generate `<dataPath>/eth-abis/<Name>.json`
   * (`{contractName, address, abi}`, from the wire-ethereum hardhat artifacts +
   * `outpost-addrs.json`), write the `liqsol_core` (OPP outpost) IDL to
   * `<dataPath>/solana-idls/` with the SOL program id as its top-level
   * `address`, and store the typed {@link OperatorDaemonArtifacts}.
   *
   * Local mode reads the addresses the outpost deploy wrote and the program id
   * from the committed program keypair. External-outpost mode reads the
   * addresses `ExternalOutpostSteps.planMaterialize` wrote from the trusted
   * config, and overlays the config's `solana.programId`. Runs ONCE, before any
   * operator node starts, and fails there when the `--ethereum-path` /
   * `--solana-path` builds lack what the daemons refuse to boot without
   * ({@link assertEthereumAbi}, {@link assertSolanaIdl}): the Ethereum outbound
   * backlog view, and the Solana account layouts and delivery record the relay decodes.
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
      EthereumOutpostBootstrapper.OutpostAddressesFile
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
      Assert.ok(
        Fs.existsSync(artifactFile),
        `prepareArtifacts: no ${contractName} ABI artifact at ${artifactFile} — is wire-ethereum built?`
      )
      const artifact = JSON.parse(Fs.readFileSync(artifactFile, "utf-8")),
        abiFile = Path.join(abiDir, `${contractName}.json`),
        address = ethereumAddresses[contractName]
      assertEthereumAbi(contractName, artifact.abi, artifactFile)
      Assert.ok(
        address != null,
        `prepareArtifacts: ${addressesFile} has no ${contractName} address to embed in its ABI`
      )
      Fs.writeFileSync(
        abiFile,
        JSON.stringify(
          {
            contractName,
            address,
            abi: artifact.abi
          },
          null,
          2
        )
      )
      return abiFile
    })

    // SOL program id — the external-outpost config's, else the committed
    // liqsol_core program keypair's — written as the top-level `address` of a
    // cluster-local copy of the built IDL, so operator nodes read a stable path
    // (nodeop accepts it via --solana-outpost-program-name liqsol_core).
    const solanaProgramId =
      ctx.config.externalOutposts?.solana.programId ??
      SolanaOutpostProgramTool.assertProgramId(solanaPath).toBase58()

    const idl = SolanaOutpostProgramTool.readIdl(solanaPath)
    assertSolanaIdl(idl, SolanaOutpostProgramTool.programIdlFile(solanaPath))
    const solanaIdlFile = Path.join(
      mkdirs(Path.join(dataPath, SolanaIdlSubpath)),
      SolanaIdlFilename
    )
    Fs.writeFileSync(
      solanaIdlFile,
      JSON.stringify({ ...idl, address: solanaProgramId }, null, 2)
    )

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

  // ── artifact checks (pure): what the daemons refuse to boot without ───────

  /**
   * Assert a daemon ABI's hardhat artifact declares every function
   * {@link RequiredEthereumAbiFunctions} names for `contractName` — for OPP the
   * `pendingOutbound()` view the relay reads the outbound backlog from, without which the
   * Ethereum client refuses to start.
   *
   * @param contractName - The daemon ABI's contract.
   * @param abi - The artifact's `abi`.
   * @param artifactFile - The artifact's path, for the messages.
   * @throws When the ABI does not parse or a required function is not declared.
   */
  export function assertEthereumAbi(
    contractName: EthereumAbiContractName,
    abi: ethers.InterfaceAbi,
    artifactFile: string
  ): void {
    const declared = Either.try(() => new ethers.Interface(abi))
      .ifLeft(error => {
        throw new NestedError(
          `prepareArtifacts: the ${contractName} ABI artifact at ${artifactFile} does not parse`,
          { cause: error, context: { contractName, artifactFile } }
        )
      })
      .getOrThrow()
    RequiredEthereumAbiFunctions[contractName].forEach(name =>
      Assert.ok(
        declared.getFunction(name) != null,
        `prepareArtifacts: the ${contractName} ABI artifact at ${artifactFile} declares no '${name}' ` +
          `function, which the batch-operator daemon requires — build wire-ethereum at an outpost version that declares it`
      )
    )
  }

  /**
   * Assert the OPP outpost IDL declares everything the batch-operator daemons decode, so a wrong
   * or stale IDL fails at artifact preparation, before any daemon starts: every
   * {@link RequiredSolanaIdlInstructions} instruction; every {@link RequiredSolanaAccountLeadingFields}
   * account opening with its leading fields (names, types and order); and the
   * {@link SolanaEpochDeliveriesAccount} account's {@link SolanaEpochDeliveriesRecordsField}
   * declared a Vec of records carrying {@link RequiredSolanaDeliveryRecordField}.
   *
   * @param idl - The parsed IDL.
   * @param idlSource - The IDL's path, for the messages.
   * @throws When an instruction, account, field or record is missing or declared differently.
   */
  export function assertSolanaIdl(idl: anchor.Idl, idlSource: string): void {
    const label = `${SolanaOutpostProgramTool.ProgramName} IDL at ${idlSource}`,
      instructionNames = new Set(
        (idl.instructions ?? []).map(instruction => instruction.name)
      )
    RequiredSolanaIdlInstructions.forEach(requiredInstruction =>
      Assert.ok(
        instructionNames.has(requiredInstruction),
        `prepareArtifacts: ${label} is missing the '${requiredInstruction}' instruction — wrong or stale IDL?`
      )
    )

    Object.entries(RequiredSolanaAccountLeadingFields).forEach(([account, requiredFields]) => {
      const declaredFields = solanaAccountFields(idl, account, label)
      requiredFields.forEach((required, position) => {
        const declared = declaredFields[position]
        Assert.ok(
          declared?.name === required.name && declared.type === required.type,
          `prepareArtifacts: ${label} declares the ${account} field ${position + 1} as ` +
            `${describeIdlField(declared)}, not ${describeIdlField(required)}: the relay decodes ` +
            `it at a fixed offset — wrong or stale IDL?`
        )
      })
    })

    const records = solanaAccountFields(idl, SolanaEpochDeliveriesAccount, label).find(
        field => field.name === SolanaEpochDeliveriesRecordsField
      ),
      recordType = match(records?.type)
        .with({ vec: { defined: { name: P.select(P.string) } } }, identity<string>)
        .otherwise(() => null)
    Assert.ok(
      recordType != null,
      `prepareArtifacts: ${label} declares ${SolanaEpochDeliveriesAccount}.${SolanaEpochDeliveriesRecordsField} ` +
        `as ${describeIdlField(records)}, not a Vec of records — wrong or stale IDL?`
    )
    const deliverer = solanaStructFields(idl, recordType, label).find(
      field => field.name === RequiredSolanaDeliveryRecordField.name
    )
    Assert.ok(
      deliverer?.type === RequiredSolanaDeliveryRecordField.type,
      `prepareArtifacts: ${label} declares the ${recordType} field '${RequiredSolanaDeliveryRecordField.name}' as ` +
        `${describeIdlField(deliverer)}, not ${describeIdlField(RequiredSolanaDeliveryRecordField)}: the relay ` +
        `finds its own recorded delivery by it — build wire-solana at an outpost version that records it`
    )
  }

  /**
   * The named fields of the IDL struct of `account`, which the IDL must also declare as an
   * account (Anchor's `accounts` list carries only names and discriminators).
   */
  function solanaAccountFields(
    idl: anchor.Idl,
    account: string,
    label: string
  ): readonly SolanaIdlField[] {
    Assert.ok(
      (idl.accounts ?? []).some(declared => declared.name === account),
      `prepareArtifacts: ${label} declares no '${account}' account — wrong or stale IDL?`
    )
    return solanaStructFields(idl, account, label)
  }

  /** The named fields of the IDL's struct type `typeName`. */
  function solanaStructFields(
    idl: anchor.Idl,
    typeName: string,
    label: string
  ): readonly SolanaIdlField[] {
    const fields = match(
      (idl.types ?? []).find(declared => declared.name === typeName)?.type
    )
      .with(
        { kind: "struct", fields: P.array({ name: P.string }) },
        struct => struct.fields
      )
      .otherwise(() => null)
    Assert.ok(
      fields != null,
      `prepareArtifacts: ${label} declares no '${typeName}' struct with named fields — wrong or stale IDL?`
    )
    return fields
  }

  /** An IDL field as a diagnostic names it: `'name' (type)`, or `nothing` when absent. */
  function describeIdlField(field: SolanaIdlField): string {
    return field == null
      ? "nothing"
      : `'${field.name}' (${JSON.stringify(field.type)})`
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
      ...EthereumReadConfirmationConfigProvider.toArgs(network.ethereumRead),
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
   * The full extra-arg block for a BATCH OPERATOR daemon: read-mode + plugins +
   * the operator's own WIRE signature provider (its unique `wire` K1 — the
   * `account`'s active key) + batch plugin config + both outpost client
   * specs. With `underwriting`, the same node also runs the plugin's underwriter
   * role as the SAME account (`--batch-underwriter-account`, permission `active`):
   * the one WIRE provider above satisfies both roles, which the plugin resolves
   * separately.
   *
   * @param underwriting - The underwriter role's caps; {@link NoBatchUnderwriting} for a
   *   relay-only node.
   */
  export function batchOperatorArgs(
    operator: OperatorAccount,
    artifacts: OperatorDaemonArtifacts,
    network: OperatorDaemonNetwork,
    keySourceFor: ClusterConfigProvider.SignatureProviderSourceFor,
    underwriting: BatchUnderwriting
  ): string[] {
    Assert.ok(
      operator.type === OperatorType.BATCH,
      `batchOperatorArgs: ${operator.label} is a ${OperatorType[operator.type]}, not a batch operator`
    )
    assertOutpostKeys(operator)
    return [
      ...batchOperatorSyncArgs(),
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
      ...pair("--batch-operator-account", operator.account),
      ...underwriterArgs(operator, underwriting),
      ...pair("--batch-epoch-poll-ms", String(BatchEpochPollMs)),
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
   * The extra args a batch-operator node SYNCS with when its OPP daemon must not
   * run — an external-outpost `create`, which never contacts the outposts: the
   * node's read mode only. No `batch_operator_plugin`, no outpost client, no
   * debugging sink. {@link batchOperatorArgs} starts with these, so a node
   * synced this way relaunches on the same read mode with its daemon added.
   *
   * @returns The sync-only extra args.
   */
  export function batchOperatorSyncArgs(): string[] {
    return pair(`--${Constants.READ_MODE_OPTION}`, NodeopReadMode.irreversible)
  }

  /**
   * The underwriter role's flags: the operator's own account and one cap per token; none for a
   * relay-only node.
   */
  function underwriterArgs(
    operator: OperatorAccount,
    underwriting: BatchUnderwriting
  ): string[] {
    if (underwriting.maxExposure.length === 0) return []
    return [
      ...pair("--batch-underwriter-account", operator.account),
      ...underwriting.maxExposure.flatMap(cap =>
        pair("--batch-underwriter-max-exposure", cap.toString())
      )
    ]
  }

  // ── Step: start an operator's daemon (process spawn — its own Step) ───────

  /** Input for {@link planDaemonStart}. */
  export interface StartDaemonInput extends StepInput {
    readonly kind: "OperatorDaemonTool.StartDaemonInput"
    readonly label: string
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
   */
  export function planDaemonStart<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, StartDaemonInput> {
    return ClusterBuildStep.create<C, StartDaemonInput>(
      actor,
      name,
      description,
      options,
      { kind: "OperatorDaemonTool.StartDaemonInput", label },
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
      daemonArgs = match(operator.type)
        .with(OperatorType.BATCH, () =>
          batchOperatorArgs(
            operator,
            artifacts,
            network,
            keySourceFor,
            underwritingFromConfig(ctx.config)
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
      extraArgs: daemonArgs
    })
    ctx.log.info(
      `[operator-daemon] ${input.label} (${operator.account}) daemon up (${nodeName}, http=${ports.http})`
    )
  }
}
