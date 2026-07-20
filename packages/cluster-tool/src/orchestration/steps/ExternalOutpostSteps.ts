import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import type * as anchor from "@coral-xyz/anchor"
import { Report } from "../../report/Report.js"
import { getLogger } from "../../logging/Logger.js"
import { NodeConfig, NodeRole } from "../../config/NodeConfig.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { NodeopProcess } from "../../cluster/processes/NodeopProcess.js"
import { OperatorDaemonTool } from "../../tools/wire/OperatorDaemonTool.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { pollUntil, verifyStep } from "../StepTools.js"
import { OperatorDaemonArtifactsKey } from "../outputs/index.js"

const log = getLogger(__filename)

/**
 * Steps for an EXTERNAL-outpost cluster — one whose Ethereum + Solana outposts
 * already run on real (remote) chains, described by
 * `ClusterConfig.externalOutposts`. In external mode the depot side bootstraps
 * normally, but NO local anvil / solana-test-validator is started and NO outpost
 * contracts are deployed; the operator-supplied artifacts are published instead
 * so the operator daemons dial the real endpoints. This module ALSO homes the
 * external-mode liveness/head-advance verify factories (Plan-2-reusable).
 */
export namespace ExternalOutpostSteps {
  /** ETH outpost address keys the daemons require (parity with local prep). */
  const RequiredEthereumAddressKeys = [
    "OPP",
    "OPPInbound",
    "OperatorRegistry",
    "ReserveManager"
  ] as const
  /** SOL outpost IDL instructions the daemons require (parity with local prep). */
  const RequiredSolanaIdlInstructions = [
    "epoch_in",
    "commit_underwrite",
    "request_swap"
  ] as const

  /** Minimum head-block advance that proves the depot is producing blocks. */
  export const HeadAdvanceMinBlocks = 2
  /** Deadline for the head-advance verify (ms). */
  export const HeadAdvanceTimeoutMs = 60_000
  /** Poll gap for the head-advance verify (ms). */
  export const HeadAdvancePollIntervalMs = 1_000

  /**
   * MATERIALIZE the config-referenced outpost files into the EXACT canonical
   * `<clusterPath>/data/...` layout the local ETH/SOL deploy produces — the
   * external-mode analogue of "the deploy wrote these files":
   * `ethereum.addressFile` → `data/ethereum-deployments/outpost-addrs.json`,
   * `liqEthAddressFile` → `…/liqeth-addrs.json`, `abiFiles` → `data/eth-abis/*.json`,
   * `solana.idlFile` → `data/solana-idls/<name>.json`, `mintsFile` →
   * `data/sol-mock-mints.json`. After this, EVERY downstream reader
   * (`RegistrySteps`, {@link runPublishArtifacts}, daemon wiring) reads `dataPath`
   * UNCHANGED — none consults `config.externalOutposts`. This is the ONLY step
   * that reads the external-outpost file references.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The materialize step.
   */
  export function planMaterialize<
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
      runMaterialize
    )
  }

  /** Named runner — copy the config's outpost files to their canonical dataPath homes. */
  export async function runMaterialize<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const external = ctx.config.externalOutposts
    Assert.ok(
      external != null,
      "ExternalOutpostSteps.planMaterialize requires config.externalOutposts (external-outpost mode only)"
    )
    const dataPath = ctx.config.dataPath,
      deploymentsDir = ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
      abiDir = Path.join(dataPath, OperatorDaemonTool.EthereumAbiSubpath),
      idlDir = Path.join(dataPath, OperatorDaemonTool.SolanaIdlSubpath),
      materialize = (source: string, destination: string): void => {
        Assert.ok(
          Fs.existsSync(source),
          `ExternalOutpostSteps.materialize: source file not found: ${source}`
        )
        Fs.mkdirSync(Path.dirname(destination), { recursive: true })
        Fs.copyFileSync(source, destination)
      }
    materialize(
      external.ethereum.addressFile,
      Path.join(deploymentsDir, "outpost-addrs.json")
    )
    if (external.ethereum.liqEthAddressFile != null) {
      materialize(
        external.ethereum.liqEthAddressFile,
        Path.join(deploymentsDir, "liqeth-addrs.json")
      )
    }
    external.ethereum.abiFiles.forEach(abiFile =>
      materialize(abiFile, Path.join(abiDir, Path.basename(abiFile)))
    )
    materialize(
      external.solana.idlFile,
      Path.join(idlDir, OperatorDaemonTool.SolanaIdlFilename)
    )
    if (external.solana.mintsFile != null) {
      materialize(
        external.solana.mintsFile,
        Path.join(dataPath, "sol-mock-mints.json")
      )
    }
  }

  /**
   * Populate {@link OperatorDaemonArtifactsKey} from the MATERIALIZED dataPath
   * files — the external replacement for `OperatorDaemonTool.planArtifactPreparation`
   * (whose ABI/IDL sources are the wire-ethereum/wire-solana CHECKOUTS, absent in
   * external mode). Reads ONLY `dataPath`, NEVER `config.externalOutposts`:
   * `outpost-addrs.json`, `eth-abis/*.json`, `solana-idls/<name>.json` (program id
   * = its top-level `address`). Run AFTER {@link planMaterialize}.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The publish-artifacts step.
   */
  export function planPublishArtifacts<
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
      runPublishArtifacts
    )
  }

  /** Named runner — store `OperatorDaemonArtifacts` from the materialized dataPath files. */
  export async function runPublishArtifacts<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const dataPath = ctx.config.dataPath,
      addressFile = Path.join(
        ClusterConfigProvider.ethereumDeploymentsPath(ctx.config),
        "outpost-addrs.json"
      ),
      abiDir = Path.join(dataPath, OperatorDaemonTool.EthereumAbiSubpath),
      idlFile = Path.join(
        dataPath,
        OperatorDaemonTool.SolanaIdlSubpath,
        OperatorDaemonTool.SolanaIdlFilename
      )

    // Ethereum: materialized addresses + ABI files; the daemon-required contract
    // keys must be present (fail here, not at first delivery).
    Assert.ok(
      Fs.existsSync(addressFile),
      `ExternalOutpostSteps: ${addressFile} not found (materialize must run first)`
    )
    const ethereumAddresses: Record<string, string> = JSON.parse(
      Fs.readFileSync(addressFile, "utf-8")
    )
    RequiredEthereumAddressKeys.forEach(key =>
      Assert.ok(
        typeof ethereumAddresses[key] === "string" &&
          ethereumAddresses[key].length > 0,
        `ExternalOutpostSteps: outpost-addrs.json is missing the ${key} address`
      )
    )
    Assert.ok(
      Fs.existsSync(abiDir),
      `ExternalOutpostSteps: ${abiDir} not found (materialize must run first)`
    )
    const ethereumAbiFiles = Fs.readdirSync(abiDir)
      .filter(file => file.endsWith(".json"))
      .map(file => Path.join(abiDir, file))
    Assert.ok(
      ethereumAbiFiles.length > 0,
      `ExternalOutpostSteps: no ETH ABI files in ${abiDir}`
    )

    // Solana: the program id is the materialized IDL's top-level `address`; it
    // must carry the daemon-required instructions.
    Assert.ok(
      Fs.existsSync(idlFile),
      `ExternalOutpostSteps: ${idlFile} not found (materialize must run first)`
    )
    const idl = JSON.parse(Fs.readFileSync(idlFile, "utf-8")) as anchor.Idl,
      solanaProgramId: string = idl.address,
      idlInstructions = new Set<string>(
        idl.instructions.map(instruction => instruction.name)
      )
    Assert.ok(
      typeof solanaProgramId === "string" && solanaProgramId.length > 0,
      `ExternalOutpostSteps: solana IDL ${idlFile} is missing its top-level 'address' (program id)`
    )
    RequiredSolanaIdlInstructions.forEach(instruction =>
      Assert.ok(
        idlInstructions.has(instruction),
        `ExternalOutpostSteps: solana IDL ${idlFile} is missing the '${instruction}' instruction`
      )
    )

    ctx.outputs.set(OperatorDaemonArtifactsKey, {
      ethereumAbiFiles,
      ethereumAddresses,
      solanaProgramId,
      solanaIdlFile: idlFile
    })
  }

  // ── endpoint-liveness verify factories (external mode) ──────────────────────

  /**
   * Verify the external Ethereum RPC endpoint is reachable + reports the
   * configured chain id (Plan-2-reusable — the compose branch composes it).
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planVerifyEthereumEndpoint<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions = {}
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(
      actor,
      name,
      description,
      async ctx => {
        const chainId = await ctx.ethereum.chainId()
        Assert.ok(
          chainId === ctx.config.externalOutposts.ethereum.chainId,
          `external Ethereum endpoint chain id ${chainId} != configured ${ctx.config.externalOutposts.ethereum.chainId}`
        )
      },
      options
    )
  }

  /**
   * Verify the external Solana RPC endpoint responds to `getVersion`
   * (Plan-2-reusable — the compose branch composes it).
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planVerifySolanaEndpoint<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions = {}
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(
      actor,
      name,
      description,
      async ctx => {
        const version = await ctx.solana.getVersion()
        Assert.ok(
          version["solana-core"] != null,
          "external Solana endpoint getVersion returned no solana-core version"
        )
      },
      options
    )
  }

  // ── head-advance liveness (shared by external create's gate + `run`) ────────

  /**
   * The external-create SUCCESS gate: the depot head block advances (there is no
   * local chain to advance an epoch on, so head-advance — not epoch distribution
   * — is the liveness signal). A verify Step over {@link runHeadBlockAdvance}.
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @returns The verify step.
   */
  export function planHeadBlockAdvance<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions = {}
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(actor, name, description, runHeadBlockAdvance, options)
  }

  /**
   * Shared head-advance liveness — poll the head node (first producer, else bios)
   * until its head block advances at least {@link HeadAdvanceMinBlocks}. Reused
   * by `ClusterManager.run` so create + run share one implementation.
   *
   * @param ctx - The build context (its process manager holds the running nodes).
   * @param signal - Abort signal.
   */
  export async function runHeadBlockAdvance<C extends ClusterBuildContext>(
    ctx: C,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const nodes = NodeConfig.plan(ctx.config),
      headNode =
        nodes.find(node => node.role === NodeRole.producer) ??
        nodes.find(node => node.role === NodeRole.bios)
    Assert.ok(
      headNode != null,
      "runHeadBlockAdvance: no producer/bios node in the topology"
    )
    const headProcess = ctx.processManager.get(headNode.name)
    Assert.ok(
      headProcess instanceof NodeopProcess,
      `runHeadBlockAdvance: ${headNode.name} is not a running nodeop`
    )
    const startHead = await headProcess.head()
    await pollUntil(
      `${headNode.name} head advances >= ${HeadAdvanceMinBlocks} blocks`,
      async () => {
        try {
          return (await headProcess.head()) - startHead >= HeadAdvanceMinBlocks
        } catch (error) {
          log.debug(
            `[external] head probe transient: ${error instanceof Error ? error.message : String(error)}`
          )
          return false
        }
      },
      HeadAdvanceTimeoutMs,
      HeadAdvancePollIntervalMs
    )
  }
}
