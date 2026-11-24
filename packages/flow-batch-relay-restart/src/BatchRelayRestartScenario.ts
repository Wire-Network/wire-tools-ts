import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"

import {
  ClusterBuildPhase,
  EthereumRoundTripScenario,
  NodeConfig,
  Report,
  Steps,
  SyndicationScenario,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext
} from "@wireio/cluster-tool"

/** Restart the sole real batch relay while a burned principal awaits external payout. */
export class BatchRelayRestartScenario extends EthereumRoundTripScenario {
  readonly name = "flow-batch-relay-restart"
  readonly description = "Restart a real relay with a queued external payout"

  protected override planBeforeRedemption(cluster: ClusterBuild): void {
    const node = BatchRelayRestartScenario.relayNode(cluster.context)
    ClusterBuildPhase.create(
      cluster,
      "StopRelay",
      "Stop the sole relay after its successful intake delivery"
    ).push(
      Steps.processes.nodeop.planStop(
        Report.Actor.BatchOperator,
        "stop-relay",
        "stop and reap the real relay, retaining its data",
        SyndicationScenario.VerifyOptions,
        node.name
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
  /**
   * Select the only planned relay; extra relays would invalidate the interruption.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The sole planned relay node.
   */
  export function relayNode(ctx: ClusterBuildContext): NodeConfig {
    const nodes = NodeConfig.batchOperatorNodes(ctx.config)
    Assert.strictEqual(
      nodes.length,
      1,
      "restart scenario requires exactly one relay"
    )
    return nodes[0]
  }
}
