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
 * `<account>@active` — the producer-lifecycle actions (`regproducer`, `regfinkey`,
 * `actfinkey`, `unregprod`) are signed by the PRODUCER, not by `sysio`, so the default
 * `<contract>@active` the invoker would supply is the wrong signer. Every one of those
 * actions already names its account in the action data, so the authorization is DERIVED
 * from it rather than riding the input as a second copy that could drift.
 */
const accountAuthorization = (account: string): PermissionLevelType[] => [
  { actor: account, permission: "active" }
]

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

  /** Input for {@link planRegproducer} — the generated `system::regproducer` data. */
  export interface RegproducerInput extends StepInput {
    readonly kind: "SystemContractSteps.RegproducerInput"
    readonly data: SysioContracts.SysioSystemRegproducerAction
  }

  /**
   * `sysio.system::regproducer` — register (or re-register) a block producer.
   *
   * Permissionless and signed by the producer itself. It is also the SINGLE door back into
   * the schedule: it clears both a voluntary `unregprod` park and an involuntary demotion
   * for missed rounds, and re-supplies the signing key `unregprod` erased. There is no
   * separate reactivation action and no cooldown.
   *
   * Must run BEFORE {@link planRegfinkey}, which requires an existing `producers` row.
   */
  export function planRegproducer<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemRegproducerAction
  ): ClusterBuildStep<C, RegproducerInput> {
    return ClusterBuildStep.create<C, RegproducerInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.RegproducerInput", data },
      runRegproducer
    )
  }

  /** Named runner — `sysio.system::regproducer`, signed by the producer. */
  export async function runRegproducer<C extends ClusterBuildContext>(
    ctx: C,
    input: RegproducerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.regproducer.invoke(input.data, {
        authorization: accountAuthorization(input.data.producer)
      })
  }

  /** Input for {@link planRegfinkey} — the generated `system::regfinkey` data. */
  export interface RegfinkeyInput extends StepInput {
    readonly kind: "SystemContractSteps.RegfinkeyInput"
    readonly data: SysioContracts.SysioSystemRegfinkeyAction
  }

  /**
   * `sysio.system::regfinkey` — register a producer's BLS finalizer key.
   *
   * An ACTIVE finalizer key is one of the three conditions a producer must meet to hold a
   * rank position at all (the others are an active `producers` row and an ACTIVE
   * `OPERATOR_TYPE_PRODUCER` row in `sysio.opreg`), so without this a collateral-backed
   * producer is never scheduled, never paid, and never eligible as a snapshot provider.
   *
   * The key must be globally unique across all producers — one BLS key per producer
   * ACCOUNT, never one shared by every account on a node.
   */
  export function planRegfinkey<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemRegfinkeyAction
  ): ClusterBuildStep<C, RegfinkeyInput> {
    return ClusterBuildStep.create<C, RegfinkeyInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.RegfinkeyInput", data },
      runRegfinkey
    )
  }

  /** Named runner — `sysio.system::regfinkey`, signed by the finalizer. */
  export async function runRegfinkey<C extends ClusterBuildContext>(
    ctx: C,
    input: RegfinkeyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.regfinkey.invoke(input.data, {
        authorization: accountAuthorization(input.data.finalizer_name)
      })
  }

  /** Input for {@link planActfinkey} — the generated `system::actfinkey` data. */
  export interface ActfinkeyInput extends StepInput {
    readonly kind: "SystemContractSteps.ActfinkeyInput"
    readonly data: SysioContracts.SysioSystemActfinkeyAction
  }

  /**
   * `sysio.system::actfinkey` — make one of a finalizer's registered keys the active one.
   *
   * A producer's FIRST registered key is activated by `regfinkey` itself, so this is only
   * needed to rotate between keys a producer already registered.
   */
  export function planActfinkey<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemActfinkeyAction
  ): ClusterBuildStep<C, ActfinkeyInput> {
    return ClusterBuildStep.create<C, ActfinkeyInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.ActfinkeyInput", data },
      runActfinkey
    )
  }

  /** Named runner — `sysio.system::actfinkey`, signed by the finalizer. */
  export async function runActfinkey<C extends ClusterBuildContext>(
    ctx: C,
    input: ActfinkeyInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.actfinkey.invoke(input.data, {
        authorization: accountAuthorization(input.data.finalizer_name)
      })
  }

  /** Input for {@link planUnregprod} — the generated `system::unregprod` data. */
  export interface UnregprodInput extends StepInput {
    readonly kind: "SystemContractSteps.UnregprodInput"
    readonly data: SysioContracts.SysioSystemUnregprodAction
  }

  /**
   * `sysio.system::unregprod` — park a producer voluntarily.
   *
   * It erases the block-signing key and clears `is_active`, which drops the producer out of
   * the schedule, out of standby pay, and out of every rank position — while leaving its
   * `sysio.opreg` status and its posted collateral untouched, so it returns at whatever
   * position its bond earns. {@link planRegproducer} is the way back.
   */
  export function planUnregprod<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemUnregprodAction
  ): ClusterBuildStep<C, UnregprodInput> {
    return ClusterBuildStep.create<C, UnregprodInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.UnregprodInput", data },
      runUnregprod
    )
  }

  /** Named runner — `sysio.system::unregprod`, signed by the producer. */
  export async function runUnregprod<C extends ClusterBuildContext>(
    ctx: C,
    input: UnregprodInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.unregprod.invoke(input.data, {
        authorization: accountAuthorization(input.data.producer)
      })
  }

  /** Input for {@link planSetscorecfg} — the generated `system::setscorecfg` data. */
  export interface SetscorecfgInput extends StepInput {
    readonly kind: "SystemContractSteps.SetscorecfgInput"
    readonly data: SysioContracts.SysioSystemSetscorecfgAction
  }

  /**
   * `sysio.system::setscorecfg` — set the per-factor weights behind a producer's rank score,
   * plus the missed-round demotion threshold.
   *
   * Governance-signed (`sysio@active`). Changing a weight invalidates every stored score at
   * once, so the contract opens a rescore sweep that `onblock` drains a bounded number of
   * rows at a time — the new weights are fully in effect a few schedule rebuilds later, not
   * in the same block.
   */
  export function planSetscorecfg<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemSetscorecfgAction
  ): ClusterBuildStep<C, SetscorecfgInput> {
    return ClusterBuildStep.create<C, SetscorecfgInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.SetscorecfgInput", data },
      runSetscorecfg
    )
  }

  /** Named runner — `sysio.system::setscorecfg`. */
  export async function runSetscorecfg<C extends ClusterBuildContext>(
    ctx: C,
    input: SetscorecfgInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.setscorecfg.invoke(input.data)
  }

  /** Input for {@link planSetacctram} — the generated `system::setacctram` data. */
  export interface SetacctramInput extends StepInput {
    readonly kind: "SystemContractSteps.SetacctramInput"
    readonly data: SysioContracts.SysioSystemSetacctramAction
  }

  /**
   * `sysio.system::setacctram` — set an account's native RAM limit directly.
   *
   * The bypass around the ROA/RAM market, and the only route available to a GENESIS producer: it
   * is created with `newaccount` rather than sponsored through `roa::newuser`, so it holds no
   * RAM allocation, and `regfinkey` bills the `finalizers` + `finkeys` rows to the producer
   * itself. Without this the registration aborts with "Account using more than allotted RAM
   * usage" and the producer can never become schedulable.
   *
   * Governance-signed (`sysio@active`).
   */
  export function planSetacctram<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSystemSetacctramAction
  ): ClusterBuildStep<C, SetacctramInput> {
    return ClusterBuildStep.create<C, SetacctramInput>(
      actor,
      name,
      description,
      options,
      { kind: "SystemContractSteps.SetacctramInput", data },
      runSetacctram
    )
  }

  /** Named runner — `sysio.system::setacctram`. */
  export async function runSetacctram<C extends ClusterBuildContext>(
    ctx: C,
    input: SetacctramInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.system)
      .actions.setacctram.invoke(input.data)
  }
}
