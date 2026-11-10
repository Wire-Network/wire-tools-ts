import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"

import {
  ClusterBuildPhase,
  ClusterBuildStep,
  EthereumRoundTripScenario,
  NodeConfig,
  NodeRole,
  Report,
  Steps,
  SyndicationScenario,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type StepInput
} from "@wireio/cluster-tool"

/** Restart the sole real batch relay while a burned principal awaits external payout. */
export class BatchRelayRestartScenario extends EthereumRoundTripScenario {
  readonly name = "flow-batch-relay-restart"
  readonly description = "Restart a real relay with a queued external payout"

  protected override planBeforeRedemption(cluster: ClusterBuild): void {
    ClusterBuildPhase.create(
      cluster,
      "StopRelay",
      "Stop the sole relay after its successful intake delivery"
    ).push(
      ClusterBuildStep.create(
        Report.Actor.BatchOperator,
        "stop-relay",
        "stop and reap the real relay, retaining its data",
        SyndicationScenario.VerifyOptions,
        { kind: "BatchRelayRestartScenario.StopInput" },
        BatchRelayRestartScenario.runStop
      )
    )
  }

  protected override planAfterRedemption(cluster: ClusterBuild): void {
    const node = BatchRelayRestartScenario.relayNode(cluster.context)
    ClusterBuildPhase.create(
      cluster,
      "RecoverRelay",
      "Resume the original relay against its retained chain data"
    ).push(
      verifyStep(
        Report.Actor.User,
        "payout-awaits-relay",
        "principal is burned but the external wallet has received nothing while the relay is absent",
        async ctx => {
          Assert.strictEqual(ctx.processManager.get(node.name), null)
          Assert.strictEqual(
            await EthereumRoundTripScenario.externalBalance(ctx),
            0n
          )
          Assert.strictEqual(
            await EthereumRoundTripScenario.shadowBalance(ctx),
            0n
          )
          const { rows, more } = await ctx.wire
            .getSysioContract(SysioContracts.SysioContractName.synd)
            .tables.returns.query({ limit: SyndicationScenario.QueryLimit })
          Assert.ok(!more)
          Assert.ok(
            rows.some(
              row =>
                row.token_code === EthereumRoundTripScenario.Token &&
                row.holder === EthereumRoundTripScenario.Holder
            ),
            "missing durable queued return"
          )
        }
      ),
      Steps.processes.nodeop.planStart(
        Report.Actor.BatchOperator,
        "restart-original-relay",
        "relaunch the same real daemon using retained data and signing keys",
        SyndicationScenario.VerifyOptions,
        node.name
      )
    )
  }
}

/** Process selection and the one stop write. */
export namespace BatchRelayRestartScenario {
  /** One process stop, separate from the restart spawn. */
  export interface StopInput extends StepInput {
    readonly kind: "BatchRelayRestartScenario.StopInput"
  }
  /**
   * Select the only planned relay; extra relays would invalidate the interruption.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The sole planned relay node.
   */
  export function relayNode(ctx: ClusterBuildContext): NodeConfig {
    const nodes = NodeConfig.plan(ctx.config).filter(
      node => node.role === NodeRole.batch_operator
    )
    Assert.strictEqual(
      nodes.length,
      1,
      "restart scenario requires exactly one relay"
    )
    return nodes[0]
  }
  /**
   * Reap the real daemon and remove only its process registration, preserving disk state.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @param _input - The reported step input; this action needs no additional payload.
   * @param signal - Cancellation signal for the reported action.
   */
  export async function runStop(
    ctx: ClusterBuildContext,
    _input: StopInput,
    signal: AbortSignal
  ): Promise<void> {
    const node = relayNode(ctx),
      process = ctx.processManager.get(node.name)
    Assert.ok(process, "relay was not running before interruption")
    await process.stop(signal)
    ctx.processManager.remove(node.name)
  }
}
