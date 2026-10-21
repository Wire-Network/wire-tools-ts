import Assert from "node:assert"
import Fs from "node:fs"
import Path from "node:path"
import { NestedError } from "@wireio/shared"
import { SlugName } from "@wireio/sdk-core"
import { ProtocolTiming } from "../../Constants.js"
import { Report } from "../../report/Report.js"
import { getLogger } from "../../logging/Logger.js"
import { NodeConfig, NodeRole } from "../../config/NodeConfig.js"
import { ClusterConfigProvider } from "../../config/ClusterConfigProvider.js"
import { NodeopProcess } from "../../cluster/processes/NodeopProcess.js"
import { SolanaFundingTool } from "../../tools/solana/SolanaFundingTool.js"
import { EthereumOutpostBootstrapper } from "../ethereum/EthereumOutpostBootstrapper.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { pollUntil, verifyStep } from "../StepTools.js"
import { packedSlugValue, slugValue } from "../../utils/slugUtils.js"

const log = getLogger(__filename)

/**
 * Steps for an EXTERNAL-outpost cluster — one whose Ethereum + Solana outposts
 * already run on their own chains, described by the trusted, value-only
 * `ClusterConfig.externalOutposts`. The depot bootstraps normally, but no local
 * anvil / solana-test-validator is started, no outpost contract is deployed and
 * the harness never contacts either outpost: the deployed values are written
 * into the canonical deploy records, and the operator-daemon ABI / IDL files are
 * built from source over them. This module also homes the external-mode
 * head-advance and outbound-envelope gates.
 */
export namespace ExternalOutpostSteps {
  /** Minimum head-block advance that proves the depot is producing blocks. */
  export const HeadAdvanceMinBlocks = 2
  /** Deadline for the head-advance verify (ms). */
  export const HeadAdvanceTimeoutMs = 60_000
  /** Poll gap for the head-advance verify (ms). */
  export const HeadAdvancePollIntervalMs = 1_000

  /**
   * Poll budget for the outbound-envelope bootstrap gate (ms) — the single-hop
   * class: the depot has to build and queue the bootstrap envelope for every
   * registered outpost, which is bounded by one epoch's envelope cadence.
   * Pinned to the TOP of its class; the poll returns the moment every outpost
   * has a row, so the ceiling costs a healthy run nothing.
   */
  export const OutboundEnvelopesPollBudgetMs = ProtocolTiming.SingleHopBudgetMs
  /** Step ceiling for the outbound-envelope gate (ms) — above its inner poll budget. */
  export const OutboundEnvelopesTimeoutMs = ProtocolTiming.DoubleHopBudgetMs
  /** Poll gap for the outbound-envelope gate (ms) — same probe cadence as the head-advance gate. */
  export const OutboundEnvelopesPollIntervalMs = HeadAdvancePollIntervalMs

  /**
   * MATERIALIZE the trusted deployed values into the canonical deploy records a
   * local ETH / SOL deploy writes — the external-mode analogue of "the deploy
   * wrote these files": `ethereum.outpostAddresses` →
   * `data/ethereum-deployments/outpost-addrs.json`, `ethereum.liqEthAddresses` →
   * `…/liqeth-addrs.json`, `solana.mints` → `data/sol-mock-mints.json`. Every
   * downstream reader (`RegistrySteps`, `OperatorDaemonTool.runArtifactPreparation`)
   * then reads them unchanged. The Solana program id needs no record: artifact
   * preparation overlays it onto the IDL it builds.
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

  /** Named runner — write the config's deployed values to their canonical dataPath records. */
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
    const deploymentsDir = ClusterConfigProvider.ethereumDeploymentsPath(
        ctx.config
      ),
      writeRecord = (file: string, record: object): void => {
        Fs.mkdirSync(Path.dirname(file), { recursive: true })
        Fs.writeFileSync(file, JSON.stringify(record, null, 2))
      }
    writeRecord(
      Path.join(
        deploymentsDir,
        EthereumOutpostBootstrapper.OutpostAddressesFile
      ),
      external.ethereum.outpostAddresses
    )
    if (external.ethereum.liqEthAddresses != null) {
      writeRecord(
        Path.join(deploymentsDir, EthereumOutpostBootstrapper.LiqEthAddressesFile),
        external.ethereum.liqEthAddresses
      )
    }
    if (external.solana.mints != null) {
      writeRecord(
        Path.join(ctx.config.dataPath, SolanaFundingTool.SolMockMintsFilename),
        external.solana.mints
      )
    }
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
   * The external-create OPP gate: the depot has QUEUED an outbound envelope for
   * every registered outpost. Head-advance ({@link planHeadBlockAdvance}) proves
   * the depot is alive; this proves the OPP side of the bootstrap actually
   * produced work for the remote outposts to consume — the closest external-mode
   * analogue of the local epoch-distribution gate (an external cluster has no
   * local chain whose epoch we can watch advance).
   *
   * @param actor - The Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options (ceiling defaults to {@link OutboundEnvelopesTimeoutMs}).
   * @returns The verify step.
   */
  export function planOutboundEnvelopesQueued<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions = { timeoutMs: OutboundEnvelopesTimeoutMs }
  ): ClusterBuildStep<C, null> {
    return verifyStep<C>(
      actor,
      name,
      description,
      runOutboundEnvelopesQueued,
      options
    )
  }

  /**
   * Named runner — poll `sysio.msgch::outenvelopes` until EVERY registered
   * (non-depot) chain in `sysio.chains::chains` has at least one queued outbound
   * envelope row. Both reads go through the typed contract-table accessors
   * (`ctx.wire.getChains()` / `getOutboundEnvelopes()`); the depot-side
   * `envelopes` count is read only to enrich a failure.
   *
   * @param ctx - The build context.
   * @param signal - Abort signal.
   */
  export async function runOutboundEnvelopesQueued<
    C extends ClusterBuildContext
  >(ctx: C, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const { rows: chains } = await ctx.wire.getChains(),
      outposts = chains.filter(chain => !chain.is_depot)
    Assert.ok(
      outposts.length > 0,
      "runOutboundEnvelopesQueued: sysio.chains::chains has no registered outpost (non-depot) chain"
    )
    // Compare PACKED values, and decode each side with the decoder for its own
    // carrier. `chains.code` is a `slug_name` ABI field — the `{value}` wrapper
    // before the depot registers the builtin, the canonical spelling after —
    // while `outenvelopes.chain_code` is declared `uint64` and renders as a
    // number, or a quoted decimal past 0xffffffff, which every real chain code
    // exceeds. Stringifying both used to work only because both happened to
    // land on the same decimal; once `code` becomes "ETH" that coincidence is
    // gone and no comparison on spellings can hold.
    const expected = outposts.map(outpost => slugValue(outpost.code)),
      expectedLabel = expected.map(code => SlugName.toString(code)).join(", ")
    try {
      await pollUntil(
        `an outbound envelope is queued for every registered outpost (${expectedLabel})`,
        async () => {
          const { rows: outbound } = await ctx.wire.getOutboundEnvelopes(),
            queued = new Set(
              outbound.map(row => packedSlugValue(row.chain_code))
            )
          return expected.every(code => queued.has(code))
        },
        OutboundEnvelopesPollBudgetMs,
        OutboundEnvelopesPollIntervalMs
      )
    } catch (error) {
      // Enrich, never mask: the depot-side envelope count says whether the
      // bootstrap produced ANY envelope or none at all. A failed diagnostic read
      // is logged and reported as absent — it can't replace the real failure.
      const depotEnvelopeCount = await ctx.wire.getEnvelopes().then(
        result => result.rows.length,
        readError => {
          log.debug(
            `[external] envelope-count diagnostic read failed: ${readError instanceof Error ? readError.message : String(readError)}`
          )
          return null
        }
      )
      throw new NestedError(
        "external-outpost bootstrap gate: the depot queued no outbound envelope for every registered outpost",
        {
          cause: error,
          context: { expected: expectedLabel, depotEnvelopeCount }
        }
      )
    }
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
