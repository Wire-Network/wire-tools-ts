import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"

import {
  mapOutpostChains,
  OutpostChainCodenames,
  type PerOutpostChain
} from "@wireio/cluster-tool-shared"

import { WireClient } from "../../../../clients/wire/WireClient.js"
import type { Constants } from "../../../../Constants.js"
import { isPackedCode } from "../../../../utils/slugUtils.js"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractAccount, SysioContractName } = SysioContracts

/**
 * Steps for `sysio.epoch` actions — the Step-layer mirror of
 * `getSysioContract(SysioContractName.epoch).actions.<action>`. Action factory
 * names match the ABI action name exactly. Each outpost chain runs its own
 * consensus epoch, so every consensus action (`setconfig`, `schbatchgps`,
 * `advance`, `pause`, `unpause`, `resendroster`, `notetraffic`) names its chain
 * in its data. A
 * chain's epochs are depot-paced: `epochcfg.epoch_duration_sec` is its minimum
 * time between two envelopes, and it advances only once it is due — it has
 * traffic (`epochstate.traffic_since`) and `epochstate.due_at` has passed — so
 * an idle chain stays in its epoch. The trailing "Reads" section holds the
 * per-chain consensus (`epochstate`, `epochcfg`, `rostersent`) and the economic clock
 * (`economycfg`, `economystate`, `blocklog`) accessors every runner / verify
 * step shares, and the pure traffic predicates over an `epochstate` row
 * ({@link EpochContractSteps.isIdle}, {@link EpochContractSteps.msUntilDue}) —
 * reads are execution details, not Steps.
 */
export namespace EpochContractSteps {
  /**
   * The `traffic_wait_sec` / `late_window_sec` that `sysio.epoch::setconfig` reads as its default,
   * half the chain's minimum duration; the chain's `epochcfg` row then holds the resolved value.
   * The bootstrap sets both to it.
   */
  export const DefaultShareOfMinimumSec = 0

  /** Input for {@link planSetconfig} — the generated `epoch::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "EpochContractSteps.SetconfigInput"
    /**
     * The action data: one outpost chain's epoch duration, traffic wait, late-delivery window,
     * group sizing and retention.
     */
    readonly data: SysioContracts.SysioEpochSetconfigAction
  }

  /**
   * `sysio.epoch::setconfig` — one outpost chain's epoch duration, traffic wait, late-delivery
   * window, group sizing, retention.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain's epoch config.
   * @returns The `sysio.epoch` step.
   */
  export function planSetconfig<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioEpochSetconfigAction
  ): ClusterBuildStep<C, SetconfigInput> {
    return ClusterBuildStep.create<C, SetconfigInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochContractSteps.SetconfigInput", data },
      runSetconfig
    )
  }

  /** Named runner — `sysio.epoch::setconfig`. */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    input: SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.setconfig.invoke(input.data)
  }

  /** Input for {@link planSeteconomy} — the economic clock's duration and grid anchor. */
  export interface SeteconomyInput extends StepInput {
    readonly kind: "EpochContractSteps.SeteconomyInput"
    /** Economic epoch length (s). */
    readonly epochDurationSec: SysioContracts.SysioEpochSeteconomyAction["epoch_duration_sec"]
    /**
     * Start of economic epoch 1 — an ISO-8601 stamp, zone-less (read as UTC) or with a zone
     * designator, as `ClusterConfigProvider.resolve` persists it already normalized — or
     * `null` to anchor it at the chain head when the step runs. A past start is caught up
     * one epoch per tick once the consensus genesis advance has run.
     */
    readonly startTime: SysioContracts.SysioEpochSeteconomyAction["start_time"]
  }

  /**
   * `sysio.epoch::seteconomy` — configure the economic clock emissions, collateral
   * withdrawals and producer pay run on. Must precede `sysio.system::initt5`, which reads
   * it, and `sysio.msgch::bootstrap`, which refuses to start without it.
   */
  export function planSeteconomy<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    epochDurationSec: SeteconomyInput["epochDurationSec"],
    startTime: SeteconomyInput["startTime"]
  ): ClusterBuildStep<C, SeteconomyInput> {
    return ClusterBuildStep.create<C, SeteconomyInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochContractSteps.SeteconomyInput", epochDurationSec, startTime },
      runSeteconomy
    )
  }

  /**
   * Named runner — `sysio.epoch::seteconomy`, a `null` start read from the chain head. A
   * configured start goes through `WireClient.toChainSeconds`, the parser
   * `ClusterConfigProvider.resolve` normalized it with, so the pushed stamp is the persisted one.
   */
  export async function runSeteconomy<C extends ClusterBuildContext>(
    ctx: C,
    input: SeteconomyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const startTime =
      input.startTime == null
        ? await ctx.wire.chainHeadTimestamp()
        : WireClient.toChainSeconds(input.startTime)
    await ctx.wire.getSysioContract(SysioContractName.epoch).actions.seteconomy.invoke({
      epoch_duration_sec: input.epochDurationSec,
      start_time: startTime
    })
  }

  /** Input for {@link planSchbatchgps} — the generated `epoch::schbatchgps` data. */
  export interface SchbatchgpsInput extends StepInput {
    readonly kind: "EpochContractSteps.SchbatchgpsInput"
    /** The action data: the outpost chain whose schedule is built. */
    readonly data: SysioContracts.SysioEpochSchbatchgpsAction
  }

  /**
   * `sysio.epoch::schbatchgps` — build one outpost chain's initial batch-operator schedule from
   * the ACTIVE batch operators SERVING it (`sysio.opreg::servchains`).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain whose schedule is built.
   * @returns The `sysio.epoch` step.
   */
  export function planSchbatchgps<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioEpochSchbatchgpsAction
  ): ClusterBuildStep<C, SchbatchgpsInput> {
    return ClusterBuildStep.create<C, SchbatchgpsInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochContractSteps.SchbatchgpsInput", data },
      runSchbatchgps
    )
  }

  /** Named runner — `sysio.epoch::schbatchgps` for the input's chain. */
  export async function runSchbatchgps<C extends ClusterBuildContext>(
    ctx: C,
    input: SchbatchgpsInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.schbatchgps.invoke(input.data)
  }

  /** Input for {@link planAdvance} — the generated `epoch::advance` data. */
  export interface AdvanceInput extends StepInput {
    readonly kind: "EpochContractSteps.AdvanceInput"
    /** The action data: the outpost chain whose consensus epoch advances. */
    readonly data: SysioContracts.SysioEpochAdvanceAction
  }

  /**
   * The account `sysio.epoch::advance` is signed by: the contract itself. Every advance of a
   * chain, its genesis advance included, needs `sysio.msgch` (its `chkcons`) or `sysio.epoch`
   * authority, and a chain's genesis advance also needs its schedule (`schbatchgps`) to exist.
   * Past its genesis a chain advances only once it is due, under either authority; otherwise
   * the action returns without effect. Under `sysio.epoch` authority it is refused for an active
   * chain whose current epoch is undecided.
   */
  export const AdvanceAccount = SysioContractAccount[SysioContractName.epoch]

  /**
   * `sysio.epoch::advance` — advance one outpost chain's consensus epoch once it is due (it has
   * traffic and `due_at` has passed; the genesis advance needs no traffic), opening the next
   * epoch at the advance time. Signed by {@link AdvanceAccount}, so refused while an active
   * chain's current epoch is undecided.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain whose consensus epoch advances.
   * @returns The `sysio.epoch` step.
   */
  export function planAdvance<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioEpochAdvanceAction
  ): ClusterBuildStep<C, AdvanceInput> {
    return ClusterBuildStep.create<C, AdvanceInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochContractSteps.AdvanceInput", data },
      runAdvance
    )
  }

  /** Named runner — `sysio.epoch::advance` for the input's chain, signed `sysio.epoch@active`. */
  export async function runAdvance<C extends ClusterBuildContext>(
    ctx: C,
    input: AdvanceInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.advance.invoke(input.data, {
        authorization: WireClient.activeAuthorization(AdvanceAccount)
      })
  }

  /**
   * The account `sysio.epoch::pause` and `unpause` require: `sysio.chalg`, which pauses a
   * chain's consensus epoch while an envelope dispute on that chain is open. Its `active`
   * authority is `sysio@active`, so governance can hold a chain's consensus the same way.
   */
  export const PauseAccount = SysioContractAccount[SysioContractName.chalg]

  /** Input for {@link planPause} — the generated `epoch::pause` data. */
  export interface PauseInput extends StepInput {
    readonly kind: "EpochContractSteps.PauseInput"
    /** The action data: the outpost chain whose consensus epoch pauses. */
    readonly data: SysioContracts.SysioEpochPauseAction
  }

  /**
   * `sysio.epoch::pause` — pause one outpost chain's consensus epoch. Every other chain keeps
   * advancing and the economic clock keeps opening economic epochs. Authorized by
   * {@link PauseAccount}.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain whose consensus epoch pauses.
   * @returns The `sysio.epoch` step.
   */
  export function planPause<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioEpochPauseAction
  ): ClusterBuildStep<C, PauseInput> {
    return ClusterBuildStep.create<C, PauseInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochContractSteps.PauseInput", data },
      runPause
    )
  }

  /** Named runner — `sysio.epoch::pause` for the input's chain, signed `sysio.chalg@active`. */
  export async function runPause<C extends ClusterBuildContext>(
    ctx: C,
    input: PauseInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.pause.invoke(input.data, {
        authorization: WireClient.activeAuthorization(PauseAccount)
      })
  }

  /** Input for {@link planUnpause} — the generated `epoch::unpause` data. */
  export interface UnpauseInput extends StepInput {
    readonly kind: "EpochContractSteps.UnpauseInput"
    /** The action data: the outpost chain whose consensus epoch resumes. */
    readonly data: SysioContracts.SysioEpochUnpauseAction
  }

  /**
   * `sysio.epoch::unpause` — resume one outpost chain's consensus epoch. Authorized by
   * {@link PauseAccount}.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain whose consensus epoch resumes.
   * @returns The `sysio.epoch` step.
   */
  export function planUnpause<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioEpochUnpauseAction
  ): ClusterBuildStep<C, UnpauseInput> {
    return ClusterBuildStep.create<C, UnpauseInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochContractSteps.UnpauseInput", data },
      runUnpause
    )
  }

  /** Named runner — `sysio.epoch::unpause` for the input's chain, signed `sysio.chalg@active`. */
  export async function runUnpause<C extends ClusterBuildContext>(
    ctx: C,
    input: UnpauseInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.unpause.invoke(input.data, {
        authorization: WireClient.activeAuthorization(PauseAccount)
      })
  }

  /**
   * The account `sysio.epoch::resendroster` requires: the contract itself, whose `active` is
   * `sysio@active` governance.
   */
  export const ResendrosterAccount = SysioContractAccount[SysioContractName.epoch]

  /** Input for {@link planResendroster} — the generated `epoch::resendroster` data. */
  export interface ResendrosterInput extends StepInput {
    readonly kind: "EpochContractSteps.ResendrosterInput"
    /** The action data: the outpost chain whose roster is queued again. */
    readonly data: SysioContracts.SysioEpochResendrosterAction
  }

  /**
   * `sysio.epoch::resendroster` — forget the roster last queued to one outpost chain, so its next
   * advance queues the roster again, and record traffic for the chain at now: governance traffic,
   * which makes an idle chain due within one minimum duration. Refused when no roster has been
   * queued to the outpost since its last advance. Signed by {@link ResendrosterAccount}.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain given traffic.
   * @returns The `sysio.epoch` step.
   */
  export function planResendroster<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioEpochResendrosterAction
  ): ClusterBuildStep<C, ResendrosterInput> {
    return ClusterBuildStep.create<C, ResendrosterInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochContractSteps.ResendrosterInput", data },
      runResendroster
    )
  }

  /** Named runner — `sysio.epoch::resendroster` for the input's chain, signed `sysio.epoch@active`. */
  export async function runResendroster<C extends ClusterBuildContext>(
    ctx: C,
    input: ResendrosterInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.resendroster.invoke(input.data, {
        authorization: WireClient.activeAuthorization(ResendrosterAccount)
      })
  }

  /**
   * The account `sysio.epoch::notetraffic` requires: `sysio.msgch`, which records a chain's
   * traffic itself (`queueout`, `buildenv`). Its `active` authority is `sysio@active`, so on a local
   * cluster the harness signs it with the same key that signs `sysio.epoch@active`.
   */
  export const NotetrafficAccount = SysioContractAccount[SysioContractName.msgch]

  /**
   * The `since` that `sysio.epoch::notetraffic` reads as now: a zero `time_point` (the contract
   * takes a zero or future `since` as the current time), so the traffic is stamped with the time of
   * the block it lands in, on the chain's own clock.
   */
  export const TrafficSinceNow = "1970-01-01T00:00:00.000"

  /** Input for {@link planNotetraffic} — the generated `epoch::notetraffic` data. */
  export interface NotetrafficInput extends StepInput {
    readonly kind: "EpochContractSteps.NotetrafficInput"
    /** The action data: the outpost chain given traffic and when that traffic began. */
    readonly data: SysioContracts.SysioEpochNotetrafficAction
  }

  /**
   * `sysio.epoch::notetraffic` — record traffic for one outpost chain since `data.since`
   * ({@link TrafficSinceNow} for now): `traffic_since` keeps the earliest, and the chain is due at
   * the later of its epoch start plus its minimum duration and that traffic plus its traffic wait
   * (`epochcfg.traffic_wait_sec`). Unlike
   * {@link planResendroster} it leaves the chain's `rostersent` alone, so the next advance queues
   * the roster only when it changed. No effect before the chain's genesis advance. Signed by
   * {@link NotetrafficAccount}.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The chain given traffic and when that traffic began.
   * @returns The `sysio.epoch` step.
   */
  export function planNotetraffic<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioEpochNotetrafficAction
  ): ClusterBuildStep<C, NotetrafficInput> {
    return ClusterBuildStep.create<C, NotetrafficInput>(
      actor,
      name,
      description,
      options,
      { kind: "EpochContractSteps.NotetrafficInput", data },
      runNotetraffic
    )
  }

  /** Named runner — `sysio.epoch::notetraffic` for the input's chain, signed `sysio.msgch@active`. */
  export async function runNotetraffic<C extends ClusterBuildContext>(
    ctx: C,
    input: NotetrafficInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.notetraffic.invoke(input.data, {
        authorization: WireClient.activeAuthorization(NotetrafficAccount)
      })
  }

  // ── Reads (execute freely inside runners / verify steps) ─────────────────

  /**
   * Row ceiling of the per-chain `epochstate` / `epochcfg` reads: the tables hold one row per
   * outpost chain, so a read that still reports `more` is refused rather than trusted.
   */
  export const ChainRowLimit = 16

  /** The per-chain consensus state table, as a truncated read names it. */
  const EpochStateTable = "epochstate"

  /** The per-chain consensus config table, as a truncated read names it. */
  const EpochConfigTable = "epochcfg"

  /** A row of a per-chain `sysio.epoch` table (`epochstate`, `epochcfg`): keyed by its chain's code. */
  export interface ChainRow {
    /** The chain's packed `uint64` code — the RPC renders it as a number or a quoted decimal. */
    readonly chain_code: SysioContracts.SysioEpochEpochStateType["chain_code"]
  }

  /**
   * Whether a per-chain row belongs to `chain`. The tables key their rows by the chain's
   * `uint64` code, which the RPC renders as a number or a quoted decimal, never as a spelling.
   *
   * @param rowChainCode - The row's `chain_code` cell.
   * @param chain - The outpost chain.
   * @returns True when the row is the chain's.
   * @throws If the cell is not a packed code (a slug spelling is refused, not misread).
   */
  export function isChainRow(
    rowChainCode: ChainRow["chain_code"],
    chain: Constants.OutpostChainCodename
  ): boolean {
    return isPackedCode(rowChainCode, chain)
  }

  /**
   * The row of `chain` among the rows of a per-chain `sysio.epoch` table — pure.
   *
   * @param rows - Every row of the table.
   * @param chain - The outpost chain.
   * @returns The chain's row (absent when the table has none for it).
   */
  export function findChainRow<Row extends ChainRow>(
    rows: readonly Row[],
    chain: Constants.OutpostChainCodename
  ): Row {
    return rows.find(row => isChainRow(row.chain_code, chain))
  }

  /**
   * Each outpost chain's row of one complete per-chain table read — pure over the read.
   *
   * @param table - The table's name, for the truncation message.
   * @param rows - The rows the read returned.
   * @param more - Whether the read reported more rows past {@link ChainRowLimit}.
   * @returns Each chain's row (absent for a chain the table has no row for).
   * @throws When the read is truncated.
   */
  function toChainRows<Row extends ChainRow>(
    table: string,
    rows: readonly Row[],
    more: boolean
  ): PerOutpostChain<Row> {
    Assert.ok(
      !more,
      `EpochContractSteps: sysio.epoch::${table} has more than ${ChainRowLimit} rows; the read is truncated`
    )
    return mapOutpostChains(chain => findChainRow(rows, chain))
  }

  /**
   * Every outpost chain's `sysio.epoch::epochstate` row from ONE read — each chain's consensus
   * epoch index, its start, its pending traffic and when it is due, its schedule window and its
   * pause.
   *
   * @param ctx - The build context.
   * @returns Each outpost chain's epoch-state row (absent for a chain before its `setconfig`).
   * @throws When the read is truncated at {@link ChainRowLimit}.
   */
  export async function readEpochStates<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<PerOutpostChain<SysioContracts.SysioEpochEpochStateType>> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .tables.epochstate.query({ limit: ChainRowLimit })
    return toChainRows(EpochStateTable, rows, more)
  }

  /** The per-chain table of the roster last queued to each outpost, as a truncated read names it. */
  const RosterSentTable = "rostersent"

  /**
   * Every outpost chain's `sysio.epoch::rostersent` row from ONE read — the hash of the
   * `OPERATORS` roster last queued to that outpost. An advance queues the roster again only when
   * its hash differs; `resendroster` erases the row so the next advance queues it regardless.
   *
   * @param ctx - The build context.
   * @returns Each outpost chain's row (absent for a chain no roster has been queued to, or whose
   *   row `resendroster` erased).
   * @throws When the read is truncated at {@link ChainRowLimit}.
   */
  export async function readRostersSent<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<PerOutpostChain<SysioContracts.SysioEpochRosterSentType>> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .tables.rostersent.query({ limit: ChainRowLimit })
    return toChainRows(RosterSentTable, rows, more)
  }

  /**
   * One outpost chain's `sysio.epoch::epochstate` row.
   *
   * @param ctx - The build context.
   * @param chain - The outpost chain.
   * @returns The chain's epoch-state row (absent before its `setconfig` has run).
   * @throws When the read is truncated at {@link ChainRowLimit}.
   */
  export async function readEpochState<C extends ClusterBuildContext>(
    ctx: C,
    chain: Constants.OutpostChainCodename
  ): Promise<SysioContracts.SysioEpochEpochStateType> {
    return (await readEpochStates(ctx))[chain]
  }

  /**
   * One outpost chain's consensus epoch index — 0 before its genesis advance (and before its
   * `epochstate` row exists).
   *
   * @param ctx - The build context.
   * @param chain - The outpost chain.
   * @returns The chain's `current_epoch_index`.
   */
  export async function readCurrentEpochIndex<C extends ClusterBuildContext>(
    ctx: C,
    chain: Constants.OutpostChainCodename
  ): Promise<number> {
    return (await readEpochState(ctx, chain))?.current_epoch_index ?? 0
  }

  /**
   * Every outpost chain's consensus epoch index from ONE `epochstate` read — 0 for a chain
   * before its genesis advance (and before its row exists).
   *
   * @param ctx - The build context.
   * @returns Each outpost chain's `current_epoch_index`.
   */
  export async function readCurrentEpochIndices<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<PerOutpostChain<number>> {
    const states = await readEpochStates(ctx)
    return mapOutpostChains(chain => states[chain]?.current_epoch_index ?? 0)
  }

  /**
   * Whether EVERY outpost chain's consensus epoch index is past its index in `before` — pure.
   * The liveness predicate of a cluster whose chains each advance on their own consensus: one
   * chain advancing alone does not satisfy it.
   *
   * @param indices - Each outpost chain's current `current_epoch_index`.
   * @param before - Each outpost chain's index to advance past.
   * @returns True once every chain is past its `before` index.
   */
  export function everyChainAdvancedPast(
    indices: Readonly<PerOutpostChain<number>>,
    before: Readonly<PerOutpostChain<number>>
  ): boolean {
    return OutpostChainCodenames.every(chain => indices[chain] > before[chain])
  }

  /**
   * Every outpost chain's `sysio.epoch::epochcfg` row from ONE read — each chain's consensus
   * epoch duration and batch-operator schedule sizing.
   *
   * @param ctx - The build context.
   * @returns Each outpost chain's epoch-config row (absent for a chain before its `setconfig`).
   * @throws When the read is truncated at {@link ChainRowLimit}.
   */
  export async function readEpochConfigs<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<PerOutpostChain<SysioContracts.SysioEpochEpochConfigType>> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .tables.epochcfg.query({ limit: ChainRowLimit })
    return toChainRows(EpochConfigTable, rows, more)
  }

  /**
   * One outpost chain's `sysio.epoch::epochcfg` row — its consensus epoch duration and
   * batch-operator schedule sizing.
   *
   * @param ctx - The build context.
   * @param chain - The outpost chain.
   * @returns The chain's epoch-config row (absent before its `setconfig` has run).
   * @throws When the read is truncated at {@link ChainRowLimit}.
   */
  export async function readEpochConfig<C extends ClusterBuildContext>(
    ctx: C,
    chain: Constants.OutpostChainCodename
  ): Promise<SysioContracts.SysioEpochEpochConfigType> {
    return (await readEpochConfigs(ctx))[chain]
  }

  /**
   * One outpost chain's consensus epoch duration from its `sysio.epoch::epochcfg` row — the
   * depot's value, the source of truth for the chain once its `setconfig` has run.
   *
   * @param ctx - The build context.
   * @param chain - The outpost chain.
   * @returns The chain's `epoch_duration_sec`.
   * @throws When the chain has no `epochcfg` row yet, or the read is truncated.
   */
  export async function readEpochDurationSec<C extends ClusterBuildContext>(
    ctx: C,
    chain: Constants.OutpostChainCodename
  ): Promise<SysioContracts.SysioEpochEpochConfigType["epoch_duration_sec"]> {
    const config = await readEpochConfig(ctx, chain)
    Assert.ok(
      config != null,
      `EpochContractSteps: sysio.epoch::epochcfg has no ${chain} row — its setconfig must run first`
    )
    return config.epoch_duration_sec
  }

  /**
   * One outpost chain's whole sliding-window batch-operator schedule — every group,
   * `[current, next, next+1]` at the default `batch_op_groups` of 3.
   *
   * @param ctx - The build context.
   * @param chain - The outpost chain.
   * @returns The chain's schedule groups (empty when it has no epoch state yet).
   */
  export async function batchOperatorGroups<C extends ClusterBuildContext>(
    ctx: C,
    chain: Constants.OutpostChainCodename
  ): Promise<string[][]> {
    return (await readEpochState(ctx, chain))?.batch_op_groups ?? []
  }

  /**
   * The epoch ms of a zero `time_point` cell — `epochstate.traffic_since` and `due_at` while the
   * chain has no traffic (the chain renders them as the Unix epoch).
   */
  export const NoTrafficMs = 0

  /**
   * When a chain may next advance (`epochstate.due_at`), in epoch ms on the chain's clock —
   * {@link NoTrafficMs} while the chain has no traffic. Pure.
   *
   * @param state - The chain's `epochstate` row.
   * @returns The chain's `due_at` (ms).
   */
  export function dueAtMs(state: SysioContracts.SysioEpochEpochStateType): number {
    return WireClient.chainTimeMs(state.due_at)
  }

  /**
   * When a chain's pending traffic began (`epochstate.traffic_since`), in epoch ms on the chain's
   * clock — {@link NoTrafficMs} while the chain has none. Pure.
   *
   * @param state - The chain's `epochstate` row.
   * @returns The chain's `traffic_since` (ms).
   */
  export function trafficSinceMs(state: SysioContracts.SysioEpochEpochStateType): number {
    return WireClient.chainTimeMs(state.traffic_since)
  }

  /**
   * Whether a chain is idle: past its genesis advance with no traffic (`due_at` zero), so it
   * never advances until traffic arrives — a depot general-lane outbound message, rows its last
   * envelope left behind ({@link planNotetraffic}, which `sysio.msgch` pushes), or a governance
   * {@link planResendroster}. Idle is not a stall: an idle chain's decided epoch simply stays
   * current. A row whose `due_at` does not parse is not idle. Pure.
   *
   * @param state - The chain's `epochstate` row (absent before its `setconfig`).
   * @returns True for a started chain with no traffic; false for a missing row, a chain before
   *   its genesis advance (which needs no traffic), or a chain with traffic.
   */
  export function isIdle(state: SysioContracts.SysioEpochEpochStateType): boolean {
    return state != null && state.current_epoch_index > 0 && dueAtMs(state) === NoTrafficMs
  }

  /**
   * How long until a chain is due its next advance at `nowMs` (ms) — `due_at` minus now, zero or
   * negative once due, and `Infinity` while the chain has no traffic (it is never due). Being due
   * is necessary, not sufficient: the chain also advances only once its current epoch is decided
   * and it is not paused. Pure.
   *
   * @param state - The chain's `epochstate` row.
   * @param nowMs - The instant measured from, in epoch ms on the chain's clock (its head time).
   * @returns The wait until due (ms), or `Infinity` with no traffic.
   */
  export function msUntilDue(
    state: SysioContracts.SysioEpochEpochStateType,
    nowMs: number
  ): number {
    const due = dueAtMs(state)
    return due === NoTrafficMs ? Number.POSITIVE_INFINITY : due - nowMs
  }

  /**
   * Whether a chain's schedule window seats `account` in any of its groups — pure over the
   * chain's `epochstate` row. A seat in ANY resident group counts: the operator owes it whether
   * the group is current or still ahead in the window.
   *
   * @param state - The chain's `epochstate` row (absent when the chain has no schedule).
   * @param account - The operator's on-chain account.
   * @returns True when a group of the window seats the account; false without a schedule.
   */
  export function isSeated(
    state: SysioContracts.SysioEpochEpochStateType,
    account: string
  ): boolean {
    return state?.batch_op_groups?.some(group => group.includes(account)) ?? false
  }

  /**
   * One outpost chain's ACTIVE batch-operator group — `batch_op_groups[current_batch_op_group]`.
   * THE one way to read "who is scheduled right now" on a chain: the window rotates, so the
   * active group is at the cursor, never a hardcoded `[0]`.
   *
   * @param ctx - The build context.
   * @param chain - The outpost chain.
   * @returns The active group's account names (absent when the chain has no schedule).
   */
  export async function activeBatchOperatorGroup<C extends ClusterBuildContext>(
    ctx: C,
    chain: Constants.OutpostChainCodename
  ): Promise<string[]> {
    const epochState = await readEpochState(ctx, chain)
    return epochState?.batch_op_groups?.[epochState.current_batch_op_group]
  }

  /**
   * Row ceiling of the {@link readBlockLog} read. The table holds at most the one open
   * episode; a read that still reports `more` is refused rather than trusted.
   */
  export const BlockLogRowLimit = 10

  /**
   * The `sysio.epoch::economycfg` singleton row — the economic clock's duration and the
   * start of its grid.
   *
   * @param ctx - The build context.
   * @returns The economic-config row (absent before `seteconomy` has run).
   */
  export async function readEconomyConfig<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioEpochEconomicConfigType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .tables.economycfg.query()
    return rows[0]
  }

  /**
   * The `sysio.epoch::economystate` singleton row — the economic epoch index and its
   * current / next boundary.
   *
   * @param ctx - The build context.
   * @returns The economic-state row (absent before the first `tickeconomy`).
   */
  export async function readEconomyState<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioEpochEconomicStateType> {
    const { rows } = await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .tables.economystate.query()
    return rows[0]
  }

  /**
   * Every `sysio.epoch::blocklog` row — at most the one open emissions block episode,
   * erased by the first economic epoch whose emissions pass the readiness gate.
   *
   * @param ctx - The build context.
   * @returns The open episode's row, or none.
   * @throws When the read is truncated at {@link BlockLogRowLimit}.
   */
  export async function readBlockLog<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioEpochBlocklogEntryType[]> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .tables.blocklog.query({ limit: BlockLogRowLimit })
    Assert.ok(
      !more,
      `EpochContractSteps: sysio.epoch::blocklog has more than ${BlockLogRowLimit} rows; the read is truncated`
    )
    return rows
  }
}
