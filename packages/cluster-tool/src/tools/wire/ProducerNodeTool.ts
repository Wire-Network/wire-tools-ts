/**
 * ProducerNodeTool — start a `nodeop` that produces blocks for ONE flow-provisioned producer
 * account, outside `NodeConfig.plan`.
 *
 * The planned topology is fixed at config-resolution time, so a producer a FLOW provisions after
 * bootstrap has no node to run on. This is the producer-side counterpart of
 * `OperatorDaemonTool.planDaemonStart` — the established precedent for spawning an ad-hoc nodeop
 * — and differs from it in exactly the ways a producing node does: it carries the producer role,
 * its own `--producer-name`, and both signature providers, and it needs no OPP daemon args.
 *
 * Ports come from `BindConfigProvider.findAvailable`; the node is peered to every planned
 * producer node so it joins the mesh and syncs before its first slot comes round.
 */

import Assert from "node:assert"
import {
  type BindConfigNodeopPorts,
  type ClusterConfig
} from "@wireio/cluster-tool-shared"
import { OperatorType } from "@wireio/opp-typescript-models"
import { BindConfigProvider } from "../../config/BindConfigProvider.js"
import { NodeConfig, NodeRole } from "../../config/NodeConfig.js"
import { NodeopProcess } from "../../cluster/processes/NodeopProcess.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { OperatorAccount } from "../../orchestration/outputs/OperatorAccount.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { Report } from "../../report/Report.js"

export namespace ProducerNodeTool {
  /** Preferred HTTP port for an ad-hoc (flow-provisioned) producer node. */
  export const PreferredProducerHttpPort = 8987
  /** Preferred p2p port for an ad-hoc (flow-provisioned) producer node. */
  export const PreferredProducerP2pPort = 9975
  /** Topology index for ad-hoc producer nodes (not part of `NodeConfig.plan`). */
  const AdHocProducerNodeIndex = -2

  /**
   * The process label + node-dir name for a flow-provisioned producer's node, keyed by the
   * producer's durable `label` handle.
   *
   * @param label - The producer's durable handle.
   * @returns The `node_<label>` process label / directory name.
   */
  export function producerNodeName(label: string): string {
    return `node_${label}`
  }

  /** Input for {@link planProducerNodeStart}. */
  export interface StartProducerNodeInput extends StepInput {
    readonly kind: "ProducerNodeTool.StartProducerNodeInput"
    /** The producer's durable handle — resolved against `ctx.keyStore` in the runner. */
    readonly label: string
  }

  /**
   * Start the flow-provisioned producer's own nodeop.
   *
   * A process spawn is its own Step, so the Report records it. The account is resolved from
   * `ctx.keyStore` in the runner — it is provisioned by a step that has not run when this one is
   * constructed.
   *
   * @param actor - The Report actor the spawn is attributed to.
   * @param name - Step name.
   * @param description - Human-readable step description.
   * @param options - Step option overrides.
   * @param label - The producer's durable handle.
   * @returns The step.
   */
  export function planProducerNodeStart<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, StartProducerNodeInput> {
    return ClusterBuildStep.create<C, StartProducerNodeInput>(
      actor,
      name,
      description,
      options,
      { kind: "ProducerNodeTool.StartProducerNodeInput", label },
      runProducerNodeStart
    )
  }

  /** Named runner — ONE nodeop spawn: the flow-provisioned producer's node. */
  export async function runProducerNodeStart<C extends ClusterBuildContext>(
    ctx: C,
    input: StartProducerNodeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const nodeName = producerNodeName(input.label)
    if (ctx.processManager.get(nodeName) != null) return

    const producer = ctx.keyStore.assertOperator(input.label)
    Assert.ok(
      producer.type === OperatorType.PRODUCER,
      `startProducerNode: ${input.label} is a ${OperatorType[producer.type]}, not a producer`
    )
    Assert.ok(
      producer.wireFinalizer != null,
      `startProducerNode: ${input.label} has no finalizer key — it could produce blocks but never vote`
    )

    const ports: BindConfigNodeopPorts = {
      http: await BindConfigProvider.findAvailable(PreferredProducerHttpPort),
      p2p: await BindConfigProvider.findAvailable(PreferredProducerP2pPort)
    }
    // startWithRecovery (not bare create+start): a flow rerun reuses this node's data dir, so an
    // unclean prior stop leaves a dirty chainbase this launch must recover from — the same
    // reasoning as every other ad-hoc and planned node path.
    await NodeopProcess.startWithRecovery(ctx.processManager, {
      node: producerNodeConfig(ctx.config, producer, ports),
      operators: [producer]
    })
    ctx.log.info(
      `[producer-node] ${input.label} (${producer.account}) up (${nodeName}, http=${ports.http})`
    )
  }

  /**
   * Compose the node's {@link NodeConfig}: a PRODUCING node named for the producer's durable
   * handle, producing for its one account, peered to every planned producer node.
   *
   * @param config - The resolved cluster config (supplies binaries, bind, genesis).
   * @param producer - The account this node produces for.
   * @param ports - The registry-issued ports it binds.
   * @returns The node config.
   */
  function producerNodeConfig(
    config: ClusterConfig,
    producer: OperatorAccount,
    ports: BindConfigNodeopPorts
  ): NodeConfig {
    const producerPeers = config.bind.nodeop.ports.producers.map(
      producerPorts =>
        `${NodeConfig.advertiseAddressFor(config, producerPorts)}:${producerPorts.p2p}`
    )
    return new NodeConfig(
      config,
      NodeRole.producer,
      AdHocProducerNodeIndex,
      producerNodeName(producer.label),
      ports,
      [producer.account],
      producerPeers
    )
  }

  /** Input for {@link planProducerNodeStop}. */
  export interface StopProducerNodeInput extends StepInput {
    readonly kind: "ProducerNodeTool.StopProducerNodeInput"
    /** The producer's durable handle — names the process to stop. */
    readonly label: string
  }

  /**
   * Stop the flow-provisioned producer's node.
   *
   * A CONTROLLED stop, not fault injection: the flow owns this process, and stopping it is how a
   * scenario makes the producer miss its rounds so the demotion model becomes observable. The
   * process is removed from the manager so a later {@link planProducerNodeStart} relaunches it
   * rather than short-circuiting on a stale handle.
   *
   * @param actor - The Report actor the stop is attributed to.
   * @param name - Step name.
   * @param description - Human-readable step description.
   * @param options - Step option overrides.
   * @param label - The producer's durable handle.
   * @returns The step.
   */
  export function planProducerNodeStop<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, StopProducerNodeInput> {
    return ClusterBuildStep.create<C, StopProducerNodeInput>(
      actor,
      name,
      description,
      options,
      { kind: "ProducerNodeTool.StopProducerNodeInput", label },
      runProducerNodeStop
    )
  }

  /** Named runner — stop the producer's node and drop it from the manager. */
  export async function runProducerNodeStop<C extends ClusterBuildContext>(
    ctx: C,
    input: StopProducerNodeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const nodeName = producerNodeName(input.label),
      running = ctx.processManager.get(nodeName)
    if (running == null) return
    await running.stop()
    ctx.processManager.remove(nodeName)
    ctx.log.info(`[producer-node] ${input.label} stopped (${nodeName})`)
  }
}
