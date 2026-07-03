import Assert from "node:assert"
import { OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../report/Report.js"
import { sleep } from "../../utils/asyncUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"

const { SysioContractName } = SysioContracts

/**
 * Bootstrap consensus setup resolved from THE cluster key store (`ctx.keyStore`):
 * BLS instant-finality activation (per producer NODE) and the producer-schedule
 * handoff (per producer {@link OperatorAccount}) off the genesis `sysio` producer.
 */
export namespace ConsensusSteps {
  /** Poll interval while waiting for the producer handoff (ms). */
  const HandoffPollIntervalMs = 1_000
  /** Deadline for the producer handoff (ms). */
  const HandoffTimeoutMs = 90_000
  /** The genesis producer that carries the chain until handoff. */
  const GenesisProducer = "sysio"

  /**
   * Activate BLS instant finality (`sysio.bios::setfinalizer`) with a policy built
   * from every producer node's generated BLS key — threshold `⌊2N/3⌋ + 1`.
   */
  export function planSetFinalizer<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runSetFinalizer
    )
  }

  /** Named runner — build the finalizer policy from node BLS keys, invoke `bios::setfinalizer`. */
  export async function runSetFinalizer<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const nodes = ctx.keyStore.nodes
    Assert.ok(nodes.length > 0, "setFinalizer: no producer node BLS keys generated")
    const finalizers = nodes.map((node, index) => ({
      description: `finalizer-${index}`,
      weight: 1,
      public_key: node.keys.bls.publicKey,
      pop: node.keys.bls.proofOfPossession
    }))
    const threshold = Math.floor((finalizers.length * 2) / 3) + 1
    await ctx.wire
      .getSysioContract(SysioContractName.bios)
      .actions.setfinalizer.invoke({ finalizer_policy: { threshold, finalizers } })
  }

  /**
   * Set the producer schedule (`sysio.system::setprodkeys`), mapping each producer
   * account to its hosting node's generated K1 signing key, then wait for the
   * handoff off the genesis `sysio` producer.
   */
  export function planSetProducerKeys<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runSetProducerKeys
    )
  }

  /** Named runner — build + set the producer schedule, then poll for handoff. */
  export async function runSetProducerKeys<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    // The schedule comes straight from the provisioned producer OperatorAccounts
    // in the ONE key store — each account's `wire` IS its node's block-signing K1.
    const producers = ctx.keyStore.operatorsByType(OperatorType.PRODUCER)
    Assert.ok(producers.length > 0, "setProducerKeys: no producer operators provisioned")
    const schedule = producers.map(producer => ({
      producer_name: producer.account,
      block_signing_key: producer.wire.publicKey
    }))
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.setprodkeys.invoke({ schedule })

    const deadline = Date.now() + HandoffTimeoutMs
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      const producer = (await ctx.wire.getInfo()).head_block_producer
      if (producer != null && producer !== GenesisProducer) return
      await sleep(HandoffPollIntervalMs)
    }
    Assert.fail(`producer handoff did not complete within ${HandoffTimeoutMs}ms`)
  }
}
