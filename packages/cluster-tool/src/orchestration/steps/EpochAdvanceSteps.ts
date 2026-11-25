import Assert from "node:assert"

import {
  describeOutpostChains,
  OutpostChainCodenames,
  type ClusterConfig,
  type PerOutpostChain
} from "@wireio/cluster-tool-shared"

import { SysioContracts } from "@wireio/sdk-core"

import { type Constants, ProtocolTiming } from "../../Constants.js"
import { getLogger } from "../../logging/Logger.js"
import { Report } from "../../report/Report.js"
import { mapSeries } from "../../utils/asyncUtils.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import { outputKey, type OutputKey } from "../OutputStore.js"
import type { StepInput } from "../StepRunner.js"
import { pollFor, pollUntil } from "../StepTools.js"
import { EpochContractSteps } from "./contracts/sysio/EpochContractSteps.js"
import { MsgchContractSteps } from "./contracts/sysio/MsgchContractSteps.js"

const log = getLogger(__filename)

/**
 * Steps and waits over every outpost chain's depot-paced consensus epoch. A chain advances only
 * once it is due — it has traffic and its minimum duration has passed since the later of its
 * epoch start and that traffic — so an idle chain stays in its decided epoch, and a wait that
 * needs a chain to advance must give it traffic. {@link EpochAdvanceSteps.keepChainsDue} is THE
 * one pump that does: it pushes `sysio.epoch::notetraffic` (signed `sysio.msgch@active`, traffic
 * since now) for each awaited chain that is idle, and {@link EpochAdvanceSteps.pollUntilKeepingDue}
 * / {@link EpochAdvanceSteps.pollForKeepingDue} run it beside a wait's predicate. The pump never
 * touches the chain's `rostersent`, so an advance it brings queues the roster only when the
 * roster changed: governance `sysio.epoch::resendroster` stays the roster-recovery action, never
 * a pump. Outpost → depot messages also need the pump until the outposts report their backlog to
 * the depot: an outpost emits its envelope only on receiving the depot's next one.
 *
 * The bootstrap's per-chain gate ({@link EpochAdvanceSteps.planAwaitEpochDecided}) waits for
 * each chain's genesis epoch to be decided — one full round trip, which needs no traffic — and
 * a snapshot of every chain's epoch index ({@link EpochAdvanceSteps.planRecordEpochIndices}) is
 * verified advanced past by a later Step ({@link EpochAdvanceSteps.planVerifyEpochIndicesAdvanced})
 * that keeps every chain due. Every wait returns the moment its condition holds, and logs and
 * retries a read that fails transiently. `ClusterManager.run`'s relaunch liveness gate is
 * {@link EpochAdvanceSteps.awaitEpochIndicesAdvanced}, the same pumped poll. A Step that must give
 * one chain traffic exactly when it is idle is {@link EpochAdvanceSteps.planKeepChainDue}.
 */
export namespace EpochAdvanceSteps {
  /**
   * The epoch the bootstrap gate waits to be decided on each chain. `sysio.msgch::bootstrap`
   * takes every chain 0 → 1 inline and ships epoch 1 with the roster and groups, so a decided
   * epoch 1 — the outpost answered and the depot accepted its envelope — is OPP circulating on
   * that outpost, not merely bootstrapped. It needs no traffic: an idle chain stays at 1.
   */
  export const BootstrapDecidedEpochIndex = 1

  /**
   * The epoch-advance budget of one outpost chain (ms) — {@link ProtocolTiming.epochAdvanceBudgetMs}
   * of the chain's minimum duration: {@link ProtocolTiming.EpochVerifyEpochCount} effective
   * epochs counted from the chain's traffic, never less than the OPP circulation (re)start.
   *
   * @param config - The resolved cluster config (its `outpostEpochDurationSec`).
   * @param chain - The outpost chain whose epoch is awaited.
   * @returns The budget (ms).
   */
  export function epochAdvanceBudgetMs(
    config: ClusterConfig,
    chain: Constants.OutpostChainCodename
  ): number {
    return ProtocolTiming.epochAdvanceBudgetMs(config.outpostEpochDurationSec[chain])
  }

  /**
   * The budget of a wait on EVERY outpost chain's epoch advancing (ms) —
   * {@link ProtocolTiming.epochAdvanceBudgetMs} of the slowest chain's minimum duration, since
   * the wait ends only once that chain has advanced too.
   *
   * @param config - The resolved cluster config (its `outpostEpochDurationSec`).
   * @returns The budget (ms).
   */
  export function everyChainAdvanceBudgetMs(config: ClusterConfig): number {
    return ProtocolTiming.epochAdvanceBudgetMs(
      ProtocolTiming.slowestOutpostEpochSec(config.outpostEpochDurationSec)
    )
  }

  // ── The keep-due pump ────────────────────────────────────────────────────

  /**
   * The chains among `chains` the pump gives traffic, in `chains` order — pure over one
   * `epochstate` read: each that is idle ({@link EpochContractSteps.isIdle}: past its genesis
   * with no traffic) and not paused. A chain with traffic is already due or will be, a paused one
   * cannot advance until it resumes, and a chain before its genesis needs no traffic.
   *
   * @param states - Each outpost chain's `epochstate` row (`EpochContractSteps.readEpochStates`).
   * @param chains - The chains a wait needs to advance.
   * @returns The chains to give traffic now.
   */
  export function chainsToKeepDue(
    states: Readonly<PerOutpostChain<SysioContracts.SysioEpochEpochStateType>>,
    chains: readonly Constants.OutpostChainCodename[]
  ): Constants.OutpostChainCodename[] {
    return chains.filter(
      chain => EpochContractSteps.isIdle(states[chain]) && !states[chain].is_paused
    )
  }

  /**
   * The `sysio.epoch::notetraffic` input the pump pushes for `chain`: traffic since now
   * (`EpochContractSteps.TrafficSinceNow`), so the chain is due one minimum duration after the
   * block the push lands in.
   *
   * @param chain - The chain given traffic.
   * @returns The named runner's input.
   */
  export function keepDueTrafficInput(
    chain: Constants.OutpostChainCodename
  ): EpochContractSteps.NotetrafficInput {
    return {
      kind: "EpochContractSteps.NotetrafficInput",
      data: { chain_code: chain, since: EpochContractSteps.TrafficSinceNow }
    }
  }

  /**
   * The `epochstate` snapshot one pump pass decides on, read BEFORE the wait's predicate (see
   * {@link pollUntilKeepingDue}). A failed read is logged and yields no snapshot, so that pass
   * pushes nothing. No chains, no read.
   *
   * @param ctx - The build context.
   * @param chains - The chains a wait needs to advance.
   * @returns Each outpost chain's `epochstate` row, or `null` without chains or on a failed read.
   */
  export async function readKeepDueSnapshot<C extends ClusterBuildContext>(
    ctx: C,
    chains: readonly Constants.OutpostChainCodename[]
  ): Promise<PerOutpostChain<SysioContracts.SysioEpochEpochStateType>> {
    if (chains.length === 0) return null
    try {
      return await EpochContractSteps.readEpochStates(ctx)
    } catch (error) {
      log.warn(`[epoch-advance] keep-due epoch-state read failed: ${errorMessage(error)}`)
      return null
    }
  }

  /**
   * One pass of THE keep-due pump over a snapshot: push `sysio.epoch::notetraffic` (traffic since
   * now, {@link keepDueTrafficInput}) for each chain of `chains` the snapshot shows idle
   * ({@link chainsToKeepDue}), so it is due one minimum duration later. Each push is
   * `EpochContractSteps.runNotetraffic`, the named runner of `planNotetraffic`, signed
   * `sysio.msgch@active` (on a local cluster, through `sysio@active`'s key, exactly as
   * `sysio.epoch@active` is), so it lands in the waiting Step's Report. The pump leaves
   * `rostersent` alone: an advance it brings queues the roster only when the roster changed.
   *
   * Writes inside a wait: rule `tools-return-orchestration-units` makes every write its own Step,
   * and this is the one sanctioned exception. A wait that needs a chain to advance cannot know at
   * plan time how many advances (so how many traffic pushes) it takes — the number depends on
   * when its predicate holds — so the pushes cannot be planned as Steps; they run inside the
   * waiting Step instead, each through the named runner of `planNotetraffic`, so the Report still
   * attributes every one. A wait whose number of pushes IS known (exactly one, when a chain is
   * idle) plans {@link planKeepChainDue} instead.
   *
   * A chain the snapshot shows with traffic gets nothing, so calling the pump on every poll pushes
   * at most once per advance. A failed push is logged and left to the next pass. No snapshot (a
   * failed read), no push.
   *
   * @param ctx - The build context.
   * @param chains - The chains a wait needs to advance.
   * @param states - The snapshot the pass decides on ({@link readKeepDueSnapshot}).
   * @param signal - Abort signal.
   * @returns The chains given traffic.
   */
  export async function keepChainsDue<C extends ClusterBuildContext>(
    ctx: C,
    chains: readonly Constants.OutpostChainCodename[],
    states: Readonly<PerOutpostChain<SysioContracts.SysioEpochEpochStateType>>,
    signal: AbortSignal
  ): Promise<Constants.OutpostChainCodename[]> {
    signal.throwIfAborted()
    if (states == null) return []
    const pushed = await mapSeries(chainsToKeepDue(states, chains), async chain => {
      try {
        await EpochContractSteps.runNotetraffic(ctx, keepDueTrafficInput(chain), signal)
        log.info(`[epoch-advance] ${chain} is idle: notetraffic gives it traffic`)
        return chain
      } catch (error) {
        signal.throwIfAborted()
        log.warn(`[epoch-advance] keep-due notetraffic for ${chain} failed: ${errorMessage(error)}`)
        return null
      }
    })
    return pushed.filter(chain => chain != null)
  }

  /**
   * {@link pollUntil} that keeps `chains` due while it waits. Each check reads the `epochstate`
   * snapshot FIRST ({@link readKeepDueSnapshot}), then runs `predicate`, and only while the
   * predicate does not hold runs one {@link keepChainsDue} pass on that snapshot. The order closes
   * the race of a chain that advances between the predicate and the pump's read: the snapshot
   * still shows its traffic, so the pump adds none, and a wait that is already satisfied never
   * pumps. THE form of every wait that needs a chain to advance, an outpost → depot delivery
   * included (the outpost emits only on the depot's next envelope).
   *
   * @param ctx - The build context.
   * @param chains - The chains the wait needs to advance.
   * @param label - What is awaited (the timeout message).
   * @param predicate - Async check; `true` ends the wait.
   * @param timeoutMs - Deadline from now (ms).
   * @param intervalMs - Delay between checks (ms).
   * @param signal - Abort signal.
   * @throws When the deadline passes before `predicate` holds.
   */
  export async function pollUntilKeepingDue<C extends ClusterBuildContext>(
    ctx: C,
    chains: readonly Constants.OutpostChainCodename[],
    label: string,
    predicate: () => Promise<boolean>,
    timeoutMs: number,
    intervalMs: number,
    signal: AbortSignal
  ): Promise<void> {
    await pollUntil(
      label,
      async () => {
        const snapshot = await readKeepDueSnapshot(ctx, chains)
        if (await predicate()) return true
        await keepChainsDue(ctx, chains, snapshot, signal)
        return false
      },
      timeoutMs,
      intervalMs
    )
  }

  /**
   * {@link pollFor} that keeps `chains` due while it waits ({@link pollUntilKeepingDue}'s
   * read-and-capture form, with the same order: snapshot, then `read`, then a pump on the
   * snapshot only while `read` yields nothing).
   *
   * @param ctx - The build context.
   * @param chains - The chains the wait needs to advance.
   * @param label - What is awaited (the timeout message).
   * @param read - Async read; a value (anything but `null` / `undefined`) ends the wait.
   * @param timeoutMs - Deadline from now (ms).
   * @param intervalMs - Delay between reads (ms).
   * @param signal - Abort signal.
   * @return The first value `read` yields.
   * @throws When the deadline passes before `read` yields a value.
   */
  export async function pollForKeepingDue<C extends ClusterBuildContext, T>(
    ctx: C,
    chains: readonly Constants.OutpostChainCodename[],
    label: string,
    read: () => Promise<T>,
    timeoutMs: number,
    intervalMs: number,
    signal: AbortSignal
  ): Promise<T> {
    return pollFor(
      label,
      async () => {
        const snapshot = await readKeepDueSnapshot(ctx, chains),
          value = await read()
        if (value == null) await keepChainsDue(ctx, chains, snapshot, signal)
        return value
      },
      timeoutMs,
      intervalMs
    )
  }

  // ── Step: give one chain traffic when it is idle ─────────────────────────

  /** Input for {@link planKeepChainDue}. */
  export interface KeepChainDueInput extends StepInput {
    readonly kind: "EpochAdvanceSteps.KeepChainDueInput"
    /** The outpost chain given traffic when it is idle. */
    readonly chain: Constants.OutpostChainCodename
  }

  /**
   * Give one outpost chain traffic exactly when it is idle ({@link runKeepChainDue}): the
   * idempotent Step form of the keep-due pump, for a flow that needs one advance of a chain at a
   * known point. Re-running it, or running it while the chain already has traffic, pushes nothing.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain given traffic when it is idle.
   * @returns The keep-due step.
   */
  export function planKeepChainDue<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: Constants.OutpostChainCodename
  ): ClusterBuildStep<C, KeepChainDueInput> {
    return ClusterBuildStep.create<C, KeepChainDueInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochAdvanceSteps.KeepChainDueInput", chain },
      runKeepChainDue
    )
  }

  /**
   * Named runner — read the chain's `epochstate` and, only when it is idle and not paused
   * ({@link chainsToKeepDue}), push one `sysio.epoch::notetraffic` ({@link keepDueTrafficInput})
   * through `EpochContractSteps.runNotetraffic`. At most one write; a refused push fails the Step.
   *
   * @param ctx - The build context.
   * @param input - The chain given traffic when it is idle.
   * @param signal - Abort signal.
   * @throws When the read or the push fails.
   */
  export async function runKeepChainDue<C extends ClusterBuildContext>(
    ctx: C,
    input: KeepChainDueInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chain } = input
    if (chainsToKeepDue(await EpochContractSteps.readEpochStates(ctx), [chain]).length === 0) {
      log.info(`[epoch-advance] ${chain} has traffic, is paused or has not started: no notetraffic`)
      return
    }
    await EpochContractSteps.runNotetraffic(ctx, keepDueTrafficInput(chain), signal)
    log.info(`[epoch-advance] ${chain} is idle: notetraffic gives it traffic`)
  }

  /** A caught error's message, for the pump's and the polls' logs. */
  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /**
   * Poll every outpost chain's consensus epoch index until `isDone` holds of it, keeping every
   * chain due ({@link pollUntilKeepingDue}). A read that throws is logged at debug and polled
   * again: the wait tolerates a transient RPC failure and fails only on the deadline, with
   * `label` in the message.
   *
   * @param ctx - The build context.
   * @param label - What the poll waits for, named in its timeout message.
   * @param isDone - Whether the chains' indices satisfy the wait.
   * @param budgetMs - The poll's deadline (ms).
   * @param signal - Abort signal.
   * @throws When the deadline passes before `isDone` holds.
   */
  async function pollEpochIndices<C extends ClusterBuildContext>(
    ctx: C,
    label: string,
    isDone: (indices: PerOutpostChain<number>) => boolean,
    budgetMs: number,
    signal: AbortSignal
  ): Promise<void> {
    await pollUntilKeepingDue(
      ctx,
      OutpostChainCodenames,
      label,
      async () => {
        try {
          return isDone(await EpochContractSteps.readCurrentEpochIndices(ctx))
        } catch (error) {
          log.debug(`[epoch-advance] epoch-state read transient: ${errorMessage(error)}`)
          return false
        }
      },
      budgetMs,
      ProtocolTiming.EpochVerifyPollIntervalMs,
      signal
    )
  }

  // ── Step: one chain's genesis epoch is decided ───────────────────────────

  /**
   * Whether a chain's `sysio.msgch::outpcons` row records an accepted winner for `epochIndex`
   * or a later epoch — pure.
   *
   * @param row - The chain's `outpcons` row (absent before its first accepted winner).
   * @param epochIndex - The epoch that must be decided.
   * @returns True once the depot accepted a winner for that epoch or a later one.
   */
  export function hasDecidedEpoch(
    row: SysioContracts.SysioMsgchOutpostConsensusEntryType,
    epochIndex: number
  ): boolean {
    return row != null && row.epoch_index >= epochIndex
  }

  /** Input for {@link planAwaitEpochDecided}. */
  export interface AwaitEpochDecidedInput extends StepInput {
    readonly kind: "EpochAdvanceSteps.AwaitEpochDecidedInput"
    /** The outpost chain whose epoch the gate watches. */
    readonly chain: Constants.OutpostChainCodename
  }

  /**
   * The bootstrap success gate of one outpost chain: wait for its epoch
   * {@link BootstrapDecidedEpochIndex} to be decided ({@link runAwaitEpochDecided}). The poll
   * owns the whole {@link epochAdvanceBudgetMs} (no Step ceiling is needed), so the Report
   * carries the poll's chain-named timeout message rather than a racing Step abort.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param chain - The outpost chain whose epoch the gate watches.
   * @returns The gate step.
   */
  export function planAwaitEpochDecided<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    chain: Constants.OutpostChainCodename
  ): ClusterBuildStep<C, AwaitEpochDecidedInput> {
    return ClusterBuildStep.create<C, AwaitEpochDecidedInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochAdvanceSteps.AwaitEpochDecidedInput", chain },
      runAwaitEpochDecided
    )
  }

  /**
   * Named runner — poll the chain's `sysio.msgch::outpcons` row until it records a winner for
   * {@link BootstrapDecidedEpochIndex} or later ({@link hasDecidedEpoch}), within
   * {@link epochAdvanceBudgetMs} of the chain. Only that chain's row decides: another chain's
   * consensus does not satisfy it. No traffic is added: the genesis epoch ships without any.
   *
   * @param ctx - The build context.
   * @param input - The chain whose epoch the gate watches.
   * @param signal - Abort signal.
   * @throws When the chain's genesis epoch is not decided by the deadline.
   */
  export async function runAwaitEpochDecided<C extends ClusterBuildContext>(
    ctx: C,
    input: AwaitEpochDecidedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const { chain } = input
    await pollUntil(
      `the ${chain} epoch ${BootstrapDecidedEpochIndex} is decided (sysio.msgch::outpcons)`,
      async () => {
        try {
          return hasDecidedEpoch(
            (await MsgchContractSteps.readOutpostConsensus(ctx))[chain],
            BootstrapDecidedEpochIndex
          )
        } catch (error) {
          log.debug(`[epoch-advance] outpcons read transient: ${errorMessage(error)}`)
          return false
        }
      },
      epochAdvanceBudgetMs(ctx.config, chain),
      ProtocolTiming.EpochVerifyPollIntervalMs
    )
  }

  // ── Wait: one chain decided and idle ─────────────────────────────────────

  /**
   * Whether a chain's current epoch is decided and the chain idle — pure: `outpcons` records the
   * winner of its current epoch ({@link hasDecidedEpoch}) and it has no traffic
   * (`EpochContractSteps.isIdle`). Its outpost has then answered the depot's current envelope and
   * emits its next one only on the depot's next envelope, which needs traffic and then one minimum
   * duration: outpost writes made now all ride that next outpost envelope together.
   *
   * @param state - The chain's `epochstate` row.
   * @param consensus - The chain's `outpcons` row (absent before its first accepted winner).
   * @returns True when the current epoch is decided and the chain has no traffic.
   */
  export function isDecidedAndIdle(
    state: SysioContracts.SysioEpochEpochStateType,
    consensus: SysioContracts.SysioMsgchOutpostConsensusEntryType
  ): boolean {
    return (
      state != null &&
      hasDecidedEpoch(consensus, state.current_epoch_index) &&
      EpochContractSteps.isIdle(state)
    )
  }

  /**
   * Wait until `chain`'s current epoch is decided and the chain idle ({@link isDecidedAndIdle}),
   * within {@link epochAdvanceBudgetMs} of the chain. Adds no traffic: a chain with traffic first
   * advances on its own and its next epoch is decided by its round trip. A read that throws is
   * logged at debug and polled again. The form of a wait whose following outpost writes must share
   * one outpost envelope — waiting for a new epoch instead returns before the outpost has answered
   * it, so writes could straddle that answer.
   *
   * @param ctx - The build context.
   * @param chain - The outpost chain.
   * @param intervalMs - Delay between reads (ms).
   * @throws When the chain is not decided and idle by the deadline.
   */
  export async function awaitDecidedAndIdle<C extends ClusterBuildContext>(
    ctx: C,
    chain: Constants.OutpostChainCodename,
    intervalMs: number
  ): Promise<void> {
    await pollUntil(
      `the ${chain} epoch is decided and the chain idle`,
      async () => {
        try {
          const [states, consensus] = await Promise.all([
            EpochContractSteps.readEpochStates(ctx),
            MsgchContractSteps.readOutpostConsensus(ctx)
          ])
          return isDecidedAndIdle(states[chain], consensus[chain])
        } catch (error) {
          log.debug(`[epoch-advance] decided-and-idle read transient: ${errorMessage(error)}`)
          return false
        }
      },
      epochAdvanceBudgetMs(ctx.config, chain),
      intervalMs
    )
  }

  // ── Wait: every chain advances past a snapshot ───────────────────────────

  /**
   * Wait until EVERY outpost chain's epoch index is past its index in `before`
   * (`EpochContractSteps.everyChainAdvancedPast`), within {@link everyChainAdvanceBudgetMs},
   * keeping every chain due ({@link keepChainsDue}) so an idle chain gets the traffic its advance
   * needs: shared by {@link runVerifyEpochIndicesAdvanced} and `ClusterManager.run`'s relaunch
   * liveness gate.
   *
   * @param ctx - The build context.
   * @param before - Each outpost chain's index to advance past.
   * @param signal - Abort signal.
   * @throws When some chain has not advanced past its index by the deadline.
   */
  export async function awaitEpochIndicesAdvanced<C extends ClusterBuildContext>(
    ctx: C,
    before: Readonly<PerOutpostChain<number>>,
    signal: AbortSignal
  ): Promise<void> {
    await pollEpochIndices(
      ctx,
      `every outpost chain's current_epoch_index advances past ${describeOutpostChains(before)}`,
      indices => EpochContractSteps.everyChainAdvancedPast(indices, before),
      everyChainAdvanceBudgetMs(ctx.config),
      signal
    )
  }

  // ── Step: record every chain's epoch index ───────────────────────────────

  /** Name prefix of every {@link epochIndicesKey}; the snapshot's name follows it. */
  export const EpochIndicesKeyPrefix = "EpochAdvanceSteps.epochIndices."

  /**
   * The `ctx.outputs` key a snapshot of every chain's epoch index is stored under, one per name,
   * so one scenario can keep several apart.
   *
   * @param snapshotName - The snapshot's name within the scenario.
   * @returns The typed key.
   */
  export function epochIndicesKey(
    snapshotName: string
  ): OutputKey<PerOutpostChain<number>> {
    return outputKey<PerOutpostChain<number>>(
      `${EpochIndicesKeyPrefix}${snapshotName}`,
      `every outpost chain's current_epoch_index, recorded as "${snapshotName}"`
    )
  }

  /** Input for {@link planRecordEpochIndices}. */
  export interface RecordEpochIndicesInput extends StepInput {
    readonly kind: "EpochAdvanceSteps.RecordEpochIndicesInput"
    /** The name the snapshot is stored under ({@link epochIndicesKey}). */
    readonly snapshotName: string
  }

  /**
   * Record every outpost chain's `current_epoch_index` now under {@link epochIndicesKey} — a
   * read, carried by a Step because a later {@link planVerifyEpochIndicesAdvanced} compares
   * against it. Every chain must have started its consensus epoch.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param snapshotName - The name the snapshot is stored under.
   * @returns The record step.
   */
  export function planRecordEpochIndices<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    snapshotName: string
  ): ClusterBuildStep<C, RecordEpochIndicesInput> {
    return ClusterBuildStep.create<C, RecordEpochIndicesInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochAdvanceSteps.RecordEpochIndicesInput", snapshotName },
      runRecordEpochIndices
    )
  }

  /**
   * Named runner — read every chain's index, assert each has started, store the snapshot.
   *
   * @param ctx - The build context.
   * @param input - The snapshot's name.
   * @param signal - Abort signal.
   * @throws When a chain's consensus epoch has not started (index 0): advancing past 0 proves
   *   only its genesis advance, never circulation.
   */
  export async function runRecordEpochIndices<C extends ClusterBuildContext>(
    ctx: C,
    input: RecordEpochIndicesInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const indices = await EpochContractSteps.readCurrentEpochIndices(ctx)
    OutpostChainCodenames.forEach(chain =>
      Assert.ok(
        indices[chain] >= 1,
        `EpochAdvanceSteps: the ${chain} consensus epoch has not started — the bootstrap's EpochBootstrap must precede the snapshot`
      )
    )
    ctx.outputs.set(epochIndicesKey(input.snapshotName), indices)
  }

  // ── Step: verify every chain advanced past the snapshot ──────────────────

  /** Input for {@link planVerifyEpochIndicesAdvanced}. */
  export interface VerifyEpochIndicesAdvancedInput extends StepInput {
    readonly kind: "EpochAdvanceSteps.VerifyEpochIndicesAdvancedInput"
    /** The snapshot every chain must advance past ({@link epochIndicesKey}). */
    readonly snapshotName: string
  }

  /**
   * Assert every outpost chain's epoch advances past its index in a recorded snapshot
   * ({@link awaitEpochIndicesAdvanced}, which keeps every chain due): a poll, so it returns the
   * moment the slowest chain moves. Pair it with `ProtocolTiming.pollStepOptions(everyChainAdvanceBudgetMs(config))` for
   * the Step's ceiling.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param snapshotName - The snapshot every chain must advance past.
   * @returns The verify step.
   */
  export function planVerifyEpochIndicesAdvanced<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    snapshotName: string
  ): ClusterBuildStep<C, VerifyEpochIndicesAdvancedInput> {
    return ClusterBuildStep.create<C, VerifyEpochIndicesAdvancedInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochAdvanceSteps.VerifyEpochIndicesAdvancedInput", snapshotName },
      runVerifyEpochIndicesAdvanced
    )
  }

  /**
   * Named runner — read the snapshot back and wait for every chain to advance past it, keeping
   * every chain due.
   *
   * @param ctx - The build context.
   * @param input - The snapshot's name.
   * @param signal - Abort signal.
   * @throws When the snapshot was never recorded, or a chain has not advanced by the deadline.
   */
  export async function runVerifyEpochIndicesAdvanced<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyEpochIndicesAdvancedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await awaitEpochIndicesAdvanced(
      ctx,
      ctx.outputs.assert(epochIndicesKey(input.snapshotName)),
      signal
    )
  }
}
