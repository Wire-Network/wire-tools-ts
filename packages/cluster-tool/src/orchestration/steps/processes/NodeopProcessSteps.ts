import { Constants } from "../../../Constants.js"
import Assert from "node:assert"
import { OperatorType } from "@wireio/opp-typescript-models"
import { KeyType } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import { match } from "ts-pattern"
import { NodeConfig, NodeRole } from "../../../config/NodeConfig.js"
import { NodeopProcess } from "../../../cluster/processes/NodeopProcess.js"
import { Report } from "../../../report/Report.js"
import { OperatorDaemonTool } from "../../../tools/wire/OperatorDaemonTool.js"
import { ClusterBuildContext } from "../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../ClusterBuildStep.js"
import { pollUntil } from "../../StepTools.js"
import type { StepInput } from "../../StepRunner.js"
import { OperatorAccount } from "../../outputs/OperatorAccount.js"
import { OperatorDaemonArtifactsKey } from "../../outputs/OperatorDaemonArtifacts.js"

const log = getLogger(__filename)

/**
 * The BIOS node's {@link OperatorAccount} — the genesis producer carrying the
 * dev K1 + BLS block-signing keys (matching genesis).
 */
const BiosOperator: OperatorAccount = {
  account: NodeConfig.BiosProducer,
  type: OperatorType.PRODUCER,
  wire: {
    type: KeyType.K1,
    publicKey: Constants.DEV_K1_PUBLIC_KEY,
    privateKey: Constants.DEV_K1_PRIVATE_KEY
  },
  bls: {
    type: KeyType.BLS,
    publicKey: Constants.DEV_BLS_PUBLIC_KEY,
    privateKey: Constants.DEV_BLS_PRIVATE_KEY,
    proofOfPossession: Constants.DEV_BLS_PROOF_OF_POSSESSION
  }
}

/** Steps that start the cluster's nodeop instances (bios / producer / operator). */
export namespace NodeopProcessSteps {
  /** Input for {@link planStart} — which planned node to planStart (by its `NodeConfig.name`). */
  export interface StartInput extends StepInput {
    readonly kind: "NodeopProcessSteps.StartInput"
    readonly nodeName: string
  }

  /**
   * Start one nodeop instance (get-or-create from `ctx.processManager`). The node
   * is resolved from `NodeConfig.plan(ctx.config)` by name and its
   * {@link OperatorAccount} from `ctx.keyStore` by role (bios → the genesis
   * producer with dev keys; producer node → its node-shared signing set; batch /
   * underwriter → the provisioned operator, whose OPP daemon args ride
   * `extraArgs`). One step per node.
   */
  export function planStart<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    nodeName: string
  ): ClusterBuildStep<C, StartInput> {
    return ClusterBuildStep.create<C, StartInput>(
      actor,
      name,
      description,
      options,
      { kind: "NodeopProcessSteps.StartInput", nodeName },
      runStart
    )
  }

  /** Named runner — resolve the node + its operator, get-or-create the {@link NodeopProcess}. */
  export async function runStart<C extends ClusterBuildContext>(
    ctx: C,
    input: StartInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const node = NodeConfig.plan(ctx.config).find(planned => planned.name === input.nodeName)
    Assert.ok(node != null, `nodeop start: node not planned: ${input.nodeName}`)
    if (ctx.processManager.get(node.name) != null) return

    const operator = resolveOperator(ctx, node)
    const nodeop = await NodeopProcess.create(ctx.processManager, {
      node,
      operator,
      extraArgs: resolveOperatorDaemonArgs(ctx, node, operator)
    })
    await nodeop.start()
  }

  /** Deadline for the restart sync gate — the node's local head catching the depot head. */
  export const SyncGateTimeoutMs = 120_000
  /** Poll gap for the restart sync gate. */
  export const SyncGatePollIntervalMs = 1_000

  /** Input for {@link planRestart} — which running node to relaunch (by its `NodeConfig.name`). */
  export interface RestartInput extends StepInput {
    readonly kind: "NodeopProcessSteps.RestartInput"
    readonly nodeName: string
  }

  /**
   * Relaunch a RUNNING nodeop after it has synced — the second boot of the old
   * create→relaunch lifecycle. A plugin whose `plugin_startup` preflight reads
   * the node's LOCAL chain state (the underwriter_plugin hard-gates on
   * `sysio.opreg` registration + `sysio.authex` links) sees only GENESIS on a
   * first boot: the fresh node has not synced when plugins start, so the
   * plugin permanently disables its cron. The relaunch REPLAYS the synced
   * chain, so the preflight sees every bootstrap-written registration.
   */
  export function planRestart<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    nodeName: string
  ): ClusterBuildStep<C, RestartInput> {
    return ClusterBuildStep.create<C, RestartInput>(
      actor,
      name,
      description,
      options,
      { kind: "NodeopProcessSteps.RestartInput", nodeName },
      runRestart
    )
  }

  /** Named runner — sync-gate, graceful stop, relaunch (genesis flags stripped). */
  export async function runRestart<C extends ClusterBuildContext>(
    ctx: C,
    input: RestartInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const node = NodeConfig.plan(ctx.config).find(planned => planned.name === input.nodeName)
    Assert.ok(node != null, `nodeop restart: node not planned: ${input.nodeName}`)
    const running = ctx.processManager.get(node.name)
    Assert.ok(
      running instanceof NodeopProcess,
      `nodeop restart: ${node.name} is not a running nodeop`
    )

    // Sync gate: the depot head at gate entry bounds the bootstrap-written
    // state (registrations, links) the second boot must be able to replay.
    const depotHead = await ctx.wire.getHead()
    await pollUntil(
      `${node.name} local head reaches depot head ${depotHead}`,
      () =>
        running.head().then(
          localHead => localHead >= depotHead,
          error => {
            log.debug(
              `${node.name} head probe transient: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
          }
        ),
      SyncGateTimeoutMs,
      SyncGatePollIntervalMs
    )

    signal.throwIfAborted()
    await running.stop()
    ctx.processManager.remove(node.name)

    const operator = resolveOperator(ctx, node)
    const relaunched = await NodeopProcess.create(ctx.processManager, {
      node,
      operator,
      extraArgs: resolveOperatorDaemonArgs(ctx, node, operator),
      relaunch: true
    })
    await relaunched.start()
  }

  /**
   * The {@link OperatorAccount} a node acts for, by role. A producer node's
   * account carries its NODE-shared signing set from `ctx.keyStore` (identical
   * to what its provisioning phase materializes); operator nodes resolve the
   * provisioned account itself.
   */
  function resolveOperator(ctx: ClusterBuildContext, node: NodeConfig): OperatorAccount {
    return match(node.role)
      .with(NodeRole.bios, () => BiosOperator)
      .with(NodeRole.producer, () => producerOperator(ctx, node))
      .otherwise(() => ctx.keyStore.assertOperator(assertOperatorAccountName(node)))
  }

  /** A producer node's OperatorAccount — its first hosted account + the node-shared keys. */
  function producerOperator(ctx: ClusterBuildContext, node: NodeConfig): OperatorAccount {
    const nodeKeys = ctx.keyStore.node(node.index)
    return {
      account: node.producers[0] ?? node.name,
      type: OperatorType.PRODUCER,
      wire: nodeKeys.keys.k1,
      bls: nodeKeys.keys.bls
    }
  }

  /** Assert an operator node names its batch / underwriter account. */
  function assertOperatorAccountName(node: NodeConfig): string {
    const account = node.batchOperatorAccount ?? node.underwriterAccount
    Assert.ok(account != null, `nodeop start: operator node ${node.name} has no operator account`)
    return account
  }

  /**
   * The OPP daemon extra args for an OPERATOR node (batch operator / underwriter),
   * built from the operator's {@link OperatorAccount} + the prepared
   * {@link OperatorDaemonArtifactsKey} artifacts; empty for bios/producer nodes.
   */
  function resolveOperatorDaemonArgs(
    ctx: ClusterBuildContext,
    node: NodeConfig,
    operator: OperatorAccount
  ): string[] {
    if (node.role !== NodeRole.operator) return []
    const artifacts = ctx.outputs.assert(OperatorDaemonArtifactsKey),
      network = OperatorDaemonTool.networkFromConfig(ctx.config)
    return node.batchOperatorAccount != null
      ? OperatorDaemonTool.batchOperatorArgs(operator, artifacts, network)
      : OperatorDaemonTool.underwriterArgs(operator, artifacts, network)
  }
}
