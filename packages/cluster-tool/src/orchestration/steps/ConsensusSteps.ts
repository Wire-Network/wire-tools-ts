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
import type { StepInput } from "../StepRunner.js"
import { SystemContractSteps } from "./contracts/sysio/SystemContractSteps.js"

const { SysioContractName } = SysioContracts

/**
 * Bootstrap consensus setup resolved from THE cluster key store (`ctx.keyStore`):
 * BLS instant-finality activation and the producer-schedule handoff, both keyed on the
 * provisioned producer {@link OperatorAccount}s, off the genesis `sysio` producer.
 */
export namespace ConsensusSteps {
  /** Poll interval while waiting for the producer handoff (ms). */
  const HandoffPollIntervalMs = 1_000
  /** Deadline for the producer handoff (ms). */
  const HandoffTimeoutMs = 90_000
  /** The genesis producer that carries the chain until handoff. */
  const GenesisProducer = "sysio"

  /**
   * Native RAM granted to a producer account before it registers — the ONE value the bootstrap
   * grants every genesis producer and a flow grants its own producer.
   *
   * Neither route to a producer account leaves room for its rows: a genesis producer is created
   * with `newaccount` and holds no allocation at all, and a `roa::newuser`-sponsored one is sized
   * for its own rows — while `regfinkey` bills the `finalizers` + `finkeys` rows to the producer.
   * Sized well clear of those two small rows rather than at their measured width: the failure
   * mode is an opaque "Account using more than allotted RAM usage" at registration, and RAM is
   * free to grant on a test chain. On a real chain a producer obtains RAM itself.
   */
  export const ProducerRamBytes = 1_000_000

  /**
   * Activate BLS instant finality (`sysio.bios::setfinalizer`) with a policy built from every
   * provisioned producer ACCOUNT's finalizer key — threshold `⌊2N/3⌋ + 1`.
   *
   * Per ACCOUNT, not per node: `sysio.system::update_ranked_producers` rebuilds the policy from
   * the keys accounts registered via `regfinkey`, so a genesis policy keyed on NODES would be
   * replaced by an account-keyed one the moment ranking first publishes — and this node would
   * hold no key for it. Building the genesis policy from the same accounts keeps the two in
   * lock-step, and it is what lets a cluster publish a ranked schedule at all.
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

  /** Named runner — build the finalizer policy from producer-account BLS keys, invoke `bios::setfinalizer`. */
  export async function runSetFinalizer<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const producers = ctx.keyStore.operatorsByType(OperatorType.PRODUCER)
    Assert.ok(
      producers.length > 0,
      "setFinalizer: no producer operators provisioned"
    )
    const finalizers = producers.map(producer => {
      Assert.ok(
        producer.wireFinalizer != null,
        `setFinalizer: producer ${producer.label} has no finalizer key`
      )
      return {
        description: producer.account,
        weight: 1,
        public_key: producer.wireFinalizer.publicKey,
        pop: producer.wireFinalizer.proofOfPossession
      }
    })
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
      // An on-chain schedule entry — the ON-CHAIN name (for producers it equals
      // the durable handle, but the chain boundary decides the field).
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

  /** Input for {@link planRegisterProducer} / {@link planRegisterFinalizerKey}. */
  export interface ProducerRegistrationInput extends StepInput {
    readonly kind: "ConsensusSteps.ProducerRegistrationInput"
    /** The producer's durable handle. */
    readonly label: string
  }

  /** Input for {@link planGrantProducerRam}. */
  export interface GrantProducerRamInput extends StepInput {
    readonly kind: "ConsensusSteps.GrantProducerRamInput"
    /** The producer's durable handle. */
    readonly label: string
    /** Native RAM limit to set, in bytes. */
    readonly ramBytes: number
  }

  /**
   * `sysio.system::setacctram` for one producer, keyed by its handle.
   *
   * `regfinkey` bills the `finalizers` + `finkeys` rows to the PRODUCER, and neither route to a
   * producer account leaves room for them: a genesis producer is created with `newaccount` and
   * holds no allocation at all, and a `roa::newuser`-sponsored one is sized for its own rows.
   * Either way the shortfall surfaces as an opaque "Account using more than allotted RAM usage"
   * at registration. On a real chain a producer obtains RAM itself; this is the harness
   * equivalent.
   *
   * Keyed by handle rather than by account because a sponsored producer's on-chain name is
   * generated by the depot at run time — there is no literal to write at plan time.
   */
  export function planGrantProducerRam<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    ramBytes: number
  ): ClusterBuildStep<C, GrantProducerRamInput> {
    return ClusterBuildStep.create<C, GrantProducerRamInput>(
      actor,
      name,
      description,
      options,
      { kind: "ConsensusSteps.GrantProducerRamInput", label, ramBytes },
      runGrantProducerRam
    )
  }

  /**
   * Named runner — resolve the producer's on-chain account from the key store, then delegate the
   * write to `SystemContractSteps.runSetacctram`.
   */
  export async function runGrantProducerRam<C extends ClusterBuildContext>(
    ctx: C,
    input: GrantProducerRamInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const producer = ctx.keyStore.assertOperator(input.label)
    await SystemContractSteps.runSetacctram(
      ctx,
      {
        kind: "SystemContractSteps.SetacctramInput",
        data: { account: producer.account, ram_bytes: input.ramBytes }
      },
      signal
    )
  }

  /**
   * `sysio.system::regproducer` for one GENESIS producer, keyed by its handle.
   *
   * The action data is resolved in the RUNNER, not at plan time: the account's keys are
   * materialized by a step that has not run yet when this one is constructed, so a plan-time
   * literal would be empty. Everything it needs rides `ctx.keyStore`.
   *
   * Registration is not optional bookkeeping — `update_ranked_producers` schedules only
   * producers with an active `producers` row, so a cluster whose genesis producers never
   * register has nothing to rank.
   */
  export function planRegisterProducer<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, ProducerRegistrationInput> {
    return ClusterBuildStep.create<C, ProducerRegistrationInput>(
      actor,
      name,
      description,
      options,
      { kind: "ConsensusSteps.ProducerRegistrationInput", label },
      runRegisterProducer
    )
  }

  /**
   * Named runner — resolve the account + its stored block-signing key from the key store, then
   * delegate the write to `SystemContractSteps.runRegproducer` (signed by the producer).
   */
  export async function runRegisterProducer<C extends ClusterBuildContext>(
    ctx: C,
    input: ProducerRegistrationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const producer = ctx.keyStore.assertOperator(input.label)
    await SystemContractSteps.runRegproducer(
      ctx,
      {
        kind: "SystemContractSteps.RegproducerInput",
        data: {
          producer: producer.account,
          producer_key: producer.wire.publicKey,
          url: "",
          location: 0
        }
      },
      signal
    )
  }

  /**
   * `sysio.system::regfinkey` for one GENESIS producer, keyed by its handle.
   *
   * Ordering is enforced by the contract, not by convention: `regfinkey` requires an existing
   * `producers` row, so {@link planRegisterProducer} must precede it. A producer's FIRST key is
   * activated by `regfinkey` itself, so no `actfinkey` follows.
   */
  export function planRegisterFinalizerKey<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string
  ): ClusterBuildStep<C, ProducerRegistrationInput> {
    return ClusterBuildStep.create<C, ProducerRegistrationInput>(
      actor,
      name,
      description,
      options,
      { kind: "ConsensusSteps.ProducerRegistrationInput", label },
      runRegisterFinalizerKey
    )
  }

  /**
   * Named runner — resolve the account's OWN BLS key + proof of possession from the key store,
   * then delegate the write to `SystemContractSteps.runRegfinkey` (signed by the finalizer).
   */
  export async function runRegisterFinalizerKey<C extends ClusterBuildContext>(
    ctx: C,
    input: ProducerRegistrationInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const producer = ctx.keyStore.assertOperator(input.label)
    Assert.ok(
      producer.wireFinalizer != null,
      `regfinkey: producer ${input.label} has no finalizer key`
    )
    await SystemContractSteps.runRegfinkey(
      ctx,
      {
        kind: "SystemContractSteps.RegfinkeyInput",
        data: {
          finalizer_name: producer.account,
          finalizer_key: producer.wireFinalizer.publicKey,
          proof_of_possession: producer.wireFinalizer.proofOfPossession
        }
      },
      signal
    )
  }
}
