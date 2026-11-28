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

/** Restart every real batch relay while a burned principal awaits external payout. */
export class BatchRelayRestartScenario extends EthereumRoundTripScenario {
  readonly name = "flow-batch-relay-restart"
  readonly description = "Restart the real relays with a queued external payout"

  protected override planBeforeRedemption(cluster: ClusterBuild): void {
    const nodes = BatchRelayRestartScenario.relayNodes(cluster.context)
    ClusterBuildPhase.create(
      cluster,
      "StopRelays",
      "Stop every relay after the successful intake delivery"
    ).push(
      ...nodes.map(node =>
        Steps.processes.nodeop.planStop(
          Report.Actor.BatchOperator,
          `stop-${node.name}`,
          `stop and reap the real relay ${node.name}, retaining its data`,
          SyndicationScenario.VerifyOptions,
          node.name
        )
      )
    )
  }

  protected override planAfterRedemption(cluster: ClusterBuild): void {
    const nodes = BatchRelayRestartScenario.relayNodes(cluster.context)
    ClusterBuildPhase.create(
      cluster,
      "RecoverRelays",
      "Resume the original relays against their retained chain data"
    ).push(
      verifyStep(
        Report.Actor.User,
        "payout-awaits-relays",
        "principal is burned but the external wallet has received nothing while every relay is absent",
        async ctx => {
          nodes.forEach(node =>
            Assert.strictEqual(ctx.processManager.get(node.name), null)
          )
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
      ...nodes.map(node =>
        Steps.processes.nodeop.planStart(
          Report.Actor.BatchOperator,
          `restart-${node.name}`,
          `relaunch the real daemon ${node.name} using retained data and signing keys`,
          SyndicationScenario.VerifyOptions,
          node.name
        )
      )
    )
  }
}

/** Relay selection for the interruption. */
export namespace BatchRelayRestartScenario {
  /**
   * Select every planned relay: the window seats at least two groups, each with its own relay, and the
   * interruption stops them all, so none delivers while the payout waits.
   * @param ctx - The live cluster context and its deployed chain clients.
   * @returns The planned relay nodes.
   */
  export function relayNodes(ctx: ClusterBuildContext): NodeConfig[] {
    const nodes = NodeConfig.batchOperatorNodes(ctx.config)
    Assert.ok(nodes.length > 0, "restart scenario requires a relay")
    return nodes
  }
}
