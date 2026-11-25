import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import { WireClient } from "../../../../clients/wire/WireClient.js"
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
 * names match the ABI action name exactly. The trailing "Reads" section holds
 * the consensus (`epochstate`, `epochcfg`) and economic clock (`economycfg`,
 * `economystate`, `blocklog`) accessors every runner / verify step shares —
 * reads are execution details, not Steps.
 */
export namespace EpochContractSteps {
  /** Input for {@link planSetconfig} — the generated `epoch::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "EpochContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioEpochSetconfigAction
  }

  /** `sysio.epoch::setconfig` — global epoch duration, group sizing, retention. */
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

  /** `sysio.epoch::schbatchgps` — build the initial batch-operator group schedule. */
  export function planSchbatchgps<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runSchbatchgps
    )
  }

  /** Named runner — `sysio.epoch::schbatchgps` (empty payload). */
  export async function runSchbatchgps<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.schbatchgps.invoke({})
  }

  /** `sysio.epoch::advance` — advance the depot epoch. */
  export function planAdvance<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runAdvance
    )
  }

  /** Named runner — `sysio.epoch::advance` (empty payload). */
  export async function runAdvance<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.getSysioContract(SysioContractName.epoch).actions.advance.invoke({})
  }

  /**
   * The account `sysio.epoch::pause` and `unpause` require: `sysio.chalg`, which pauses the
   * consensus epoch while an envelope dispute is open. Its `active` authority is
   * `sysio@active`, so governance can hold consensus the same way.
   */
  export const PauseAccount = SysioContractAccount[SysioContractName.chalg]

  /**
   * `sysio.epoch::pause` — set the global pause, which stops the consensus epoch only: the
   * economic clock keeps opening economic epochs. Authorized by {@link PauseAccount}.
   */
  export function planPause<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runPause
    )
  }

  /** Named runner — `sysio.epoch::pause` (empty payload), signed `sysio.chalg@active`. */
  export async function runPause<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.pause.invoke({}, { authorization: WireClient.activeAuthorization(PauseAccount) })
  }

  /** `sysio.epoch::unpause` — clear the global pause. Authorized by {@link PauseAccount}. */
  export function planUnpause<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runUnpause
    )
  }

  /** Named runner — `sysio.epoch::unpause` (empty payload), signed `sysio.chalg@active`. */
  export async function runUnpause<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.epoch)
      .actions.unpause.invoke({}, { authorization: WireClient.activeAuthorization(PauseAccount) })
  }

  // ── Reads (execute freely inside runners / verify steps) ─────────────────

  /**
   * The `sysio.epoch::epochstate` singleton row.
   *
   * @param ctx - The build context.
   * @returns The epoch-state row (absent before the depot bootstraps it).
   */
  export async function readEpochState<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioEpochEpochStateType> {
    const { rows } = await ctx.wire.getEpochState()
    return rows[0]
  }

  /**
   * The `sysio.epoch::epochcfg` singleton row — the depot's global epoch
   * duration and batch-operator schedule sizing.
   *
   * @param ctx - The build context.
   * @returns The epoch-config row (absent before `setconfig` has run).
   */
  export async function readEpochConfig<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioEpochEpochConfigType> {
    const { rows } = await ctx.wire.getEpochConfig()
    return rows[0]
  }

  /**
   * The depot's whole sliding-window batch-operator schedule — every group,
   * `[current, next, next+1]` at the default `batch_op_groups` of 3.
   *
   * @param ctx - The build context.
   * @returns The schedule groups (empty when the epoch state has no row yet).
   */
  export async function batchOperatorGroups<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<string[][]> {
    return (await readEpochState(ctx))?.batch_op_groups ?? []
  }

  /**
   * The ACTIVE batch-operator group — `batch_op_groups[current_batch_op_group]`.
   * THE one way to read "who is scheduled right now": the window rotates, so the
   * active group is at the cursor, never a hardcoded `[0]`.
   *
   * @param ctx - The build context.
   * @returns The active group's account names (absent when no schedule exists).
   */
  export async function activeBatchOperatorGroup<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<string[]> {
    const epochState = await readEpochState(ctx)
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
