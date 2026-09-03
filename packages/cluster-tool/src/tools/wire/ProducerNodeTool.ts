/**
 * ProducerNodeTool — start (and stop) a `nodeop` that produces blocks for ONE flow-provisioned
 * producer account, outside `NodeConfig.plan`.
 *
 * The planned topology is fixed at config-resolution time, so a producer a FLOW provisions after
 * bootstrap has no node to run on. This is the producer-side counterpart of
 * `OperatorDaemonTool.planDaemonStart`: both compose their node through `NodeConfig.createAdHoc`
 * (named for the operator's durable label, peered to every planned producer node, on
 * `BindConfigProvider.findAvailableAdHocPorts`-issued ports), and a producing node differs only
 * in what that composition derives from its type — the producer role, its own `--producer-name`,
 * and both signature providers — and in needing no OPP daemon args.
 */

import Assert from "node:assert"
import { OperatorType } from "@wireio/opp-typescript-models"
import { BindConfigProvider } from "../../config/BindConfigProvider.js"
import { NodeConfig } from "../../config/NodeConfig.js"
import { NodeopProcess } from "../../cluster/processes/NodeopProcess.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { Report } from "../../report/Report.js"

export namespace ProducerNodeTool {
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
    const nodeName = NodeConfig.adHocNodeName(input.label)
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

    const ports = await BindConfigProvider.findAvailableAdHocPorts()
    // startWithRecovery (not bare create+start): a flow rerun reuses this node's data dir, so an
    // unclean prior stop leaves a dirty chainbase this launch must recover from — the same
    // reasoning as every other ad-hoc and planned node path.
    await NodeopProcess.startWithRecovery(ctx.processManager, {
      node: NodeConfig.createAdHoc(ctx.config, producer, ports),
      operators: [producer]
    })
    ctx.log.info(
      `[producer-node] ${input.label} (${producer.account}) up (${nodeName}, http=${ports.http})`
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
    const nodeName = NodeConfig.adHocNodeName(input.label),
      running = ctx.processManager.get(nodeName)
    if (running == null) return
    await running.stop()
    ctx.processManager.remove(nodeName)
    ctx.log.info(`[producer-node] ${input.label} stopped (${nodeName})`)
  }
}
