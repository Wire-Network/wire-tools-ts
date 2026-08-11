import { type PermissionLevelType, SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/**
 * Steps for `sysio.system` actions (the system contract on the `sysio` account,
 * post-ROA). The remaining one-offs (`init` / `setprodkeys` / `newaccount` /
 * `updateauth`) land here as they are migrated; `setfinalizer` / `setpriv` are
 * bios-ABI actions and belong under `Steps.contracts.sysio.bios`.
 */
export namespace SystemContractSteps {
  /** Chars of an ISO-8601 timestamp up to seconds (`YYYY-MM-DDTHH:MM:SS`). */
  const IsoSecondsLength = 19
  /** Suffix appended to the chain's `head_block_time` so it parses as UTC. */
  const UtcSuffix = "Z"

  /**
   * The chain's `head_block_time` as a second-precision ISO-8601 timestamp.
   *
   * Every singleton anchored to a start instant reads it from here rather than from the
   * local wall clock, because the contracts measure elapsed time against the chain's own
   * clock — a local-clock anchor skews vesting and epoch accrual by the host's drift.
   */
  async function chainHeadTimestamp<C extends ClusterBuildContext>(ctx: C): Promise<string> {
    const info = await ctx.wire.getInfo()
    return new Date(info.head_block_time + UtcSuffix)
      .toISOString()
      .slice(0, IsoSecondsLength)
  }

  /** Input for {@link planSetemitcfg} — the generated emission-config struct. */
  export interface SetemitcfgInput extends StepInput {
    readonly kind: "SystemContractSteps.SetemitcfgInput"
    readonly data: SysioContracts.SysioSystemEmissionConfigType
  }

  /** `sysio.system::setemitcfg` — set the emission config. */
  export function planSetemitcfg<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemEmissionConfigType
  ): ClusterBuildStep<C, SetemitcfgInput> {
    return ClusterBuildStep.create<C, SetemitcfgInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.SetemitcfgInput", data },
      runSetemitcfg
    )
  }

  /** Named runner — `sysio.system::setemitcfg` (wraps the config in `{ cfg }`). */
  export async function runSetemitcfg<C extends ClusterBuildContext>(
    ctx: C,
    input: SetemitcfgInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.setemitcfg.invoke({ cfg: input.data })
  }

  /**
   * `sysio.system::setinittime` — seed the `emissionmngr` singleton with the node-owner
   * distribution commencement time, anchored to the chain's `head_block_time`.
   *
   * Every tier's vesting schedule is measured from this one instant, so until it is set
   * `claimnodedis` aborts with "emission state not initialized" and no node owner can ever
   * claim — registration itself succeeds, which is what makes the omission silent. Must run
   * AFTER `setemitcfg` (the action reads the emission config) and is one-shot: the contract
   * rejects a second call.
   *
   * Input-less; the runner reads the head time. Production substitutes the approved
   * Distribution Commencement Date for the chain head.
   */
  export function planSetinittime<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runSetinittime
    )
  }

  /** Named runner — `sysio.system::setinittime` anchored to chain head time. */
  export async function runSetinittime<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.setinittime.invoke({
        no_reward_init_time: await chainHeadTimestamp(ctx)
      })
  }

  /**
   * `sysio.system::initt5` — seed the `t5_state` singleton, anchored to the
   * chain's `head_block_time` (the clock `accrueepoch` uses). Input-less; the
   * runner reads the head time.
   */
  export function planInitt5<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runInitt5
    )
  }

  /** Named runner — `sysio.system::initt5` anchored to chain head time. */
  export async function runInitt5<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.initt5.invoke({ start_time: await chainHeadTimestamp(ctx) })
  }

  /** Input for {@link planInit} — the generated `system::init` data. */
  export interface InitInput extends StepInput {
    readonly kind: "SystemContractSteps.InitInput"
    readonly data: SysioContracts.SysioSystemInitAction
  }

  /** `sysio.system::init` — initialize the system contract state. */
  export function planInit<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemInitAction
  ): ClusterBuildStep<C, InitInput> {
    return ClusterBuildStep.create<C, InitInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.InitInput", data },
      runInit
    )
  }

  /** Named runner — `sysio.system::init`. */
  export async function runInit<C extends ClusterBuildContext>(
    ctx: C,
    input: InitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.getSysioContract(SysioContractName.system).actions.init.invoke(input.data)
  }

  /** Input for {@link planSetprodkeys} — the generated `system::setprodkeys` data. */
  export interface SetprodkeysInput extends StepInput {
    readonly kind: "SystemContractSteps.SetprodkeysInput"
    readonly data: SysioContracts.SysioSystemSetprodkeysAction
  }

  /** `sysio.system::setprodkeys` — set the producer schedule (post-ROA producer handoff). */
  export function planSetprodkeys<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemSetprodkeysAction
  ): ClusterBuildStep<C, SetprodkeysInput> {
    return ClusterBuildStep.create<C, SetprodkeysInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.SetprodkeysInput", data },
      runSetprodkeys
    )
  }

  /** Named runner — `sysio.system::setprodkeys`. */
  export async function runSetprodkeys<C extends ClusterBuildContext>(
    ctx: C,
    input: SetprodkeysInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.setprodkeys.invoke(input.data)
  }

  /** Input for {@link planNewaccount} — the generated `system::newaccount` data. */
  export interface NewaccountInput extends StepInput {
    readonly kind: "SystemContractSteps.NewaccountInput"
    readonly data: SysioContracts.SysioSystemNewaccountAction
  }

  /** `sysio.system::newaccount` — create a RAM-gifted account (post-ROA). */
  export function planNewaccount<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemNewaccountAction
  ): ClusterBuildStep<C, NewaccountInput> {
    return ClusterBuildStep.create<C, NewaccountInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.NewaccountInput", data },
      runNewaccount
    )
  }

  /** Named runner — `sysio.system::newaccount`. */
  export async function runNewaccount<C extends ClusterBuildContext>(
    ctx: C,
    input: NewaccountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.newaccount.invoke(input.data)
  }

  /** Input for {@link planSetpriv} — the generated `system::setpriv` data. */
  export interface SetprivInput extends StepInput {
    readonly kind: "SystemContractSteps.SetprivInput"
    readonly data: SysioContracts.SysioSystemSetprivAction
  }

  /** `sysio.system::setpriv` — mark an account privileged (post-ROA). */
  export function planSetpriv<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemSetprivAction
  ): ClusterBuildStep<C, SetprivInput> {
    return ClusterBuildStep.create<C, SetprivInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.SetprivInput", data },
      runSetpriv
    )
  }

  /** Named runner — `sysio.system::setpriv`. */
  export async function runSetpriv<C extends ClusterBuildContext>(
    ctx: C,
    input: SetprivInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.setpriv.invoke(input.data)
  }

  /**
   * Input for {@link planUpdateauth} — the generated `system::updateauth` data plus
   * the explicit authorization (updateauth is signed by the account being
   * modified, `<account>@owner`/`@active`, NOT the default `sysio@active`).
   */
  export interface UpdateauthInput extends StepInput {
    readonly kind: "SystemContractSteps.UpdateauthInput"
    readonly data: SysioContracts.SysioSystemUpdateauthAction
    readonly authorization: PermissionLevelType[]
  }

  /** `sysio.system::updateauth` — set an account's permission authority (grants, cross-delegation). */
  export function planUpdateauth<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemUpdateauthAction,
    authorization: PermissionLevelType[]
  ): ClusterBuildStep<C, UpdateauthInput> {
    return ClusterBuildStep.create<C, UpdateauthInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.UpdateauthInput", data, authorization },
      runUpdateauth
    )
  }

  /** Named runner — `sysio.system::updateauth` with the caller-supplied authorization. */
  export async function runUpdateauth<C extends ClusterBuildContext>(
    ctx: C,
    input: UpdateauthInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.updateauth.invoke(input.data, { authorization: input.authorization })
  }
}
