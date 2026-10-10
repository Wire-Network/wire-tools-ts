import { SysioContracts } from "@wireio/sdk-core"
import { WireClient } from "../../../../clients/wire/WireClient.js"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName, SysioContractAccount } = SysioContracts

/**
 * Steps for `sysio.kicker` actions — the governance-budgeted T5 WIRE gifts to
 * LIQ holders.
 *
 * The configuration actions (`setconfig`, `addpool`, `setpool`) require the
 * governance account, so they are signed by `sysio@active`
 * ({@link KickerContractSteps.GovernanceAuthorization}). The permissionless
 * `kick` has no Step here: the batch operators' crank pushes it, and a flow
 * that kicks composes the action into its own transaction.
 */
export namespace KickerContractSteps {
  /**
   * `sysio@active` — the governance authority `setconfig`, `addpool` and
   * `setpool` `require_auth`. The contract account's own active permission (the
   * typed client's default) is NOT accepted by those actions.
   */
  export const GovernanceAuthorization = WireClient.activeAuthorization(
    SysioContractAccount[SysioContractName.system]
  )

  /** Input for {@link planSetconfig} — the generated `kicker::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "KickerContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioKickerSetconfigAction
  }

  /**
   * `sysio.kicker::setconfig` — replace the absolute remaining budget and the
   * minimum unpaid interval. Never settles an open interval. Signed by `sysio`.
   */
  export function planSetconfig<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioKickerSetconfigAction
  ): ClusterBuildStep<C, SetconfigInput> {
    return ClusterBuildStep.create<C, SetconfigInput>(
      actor,
      name,
      description,
      options,
      { kind: "KickerContractSteps.SetconfigInput", data },
      runSetconfig
    )
  }

  /** Named runner — `sysio.kicker::setconfig`, signed by `sysio`. */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    input: SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.kicker)
      .actions.setconfig.invoke(input.data, {
        authorization: GovernanceAuthorization
      })
  }

  /** Input for {@link planAddpool} — the generated `kicker::addpool` data. */
  export interface AddpoolInput extends StepInput {
    readonly kind: "KickerContractSteps.AddpoolInput"
    readonly data: SysioContracts.SysioKickerAddpoolAction
  }

  /**
   * `sysio.kicker::addpool` — start one LIQ token's accrual clock now. The
   * token must already have its LIQ/WIRE yield pool (`sysio.liq::regliqpool`).
   * Signed by `sysio`.
   */
  export function planAddpool<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioKickerAddpoolAction
  ): ClusterBuildStep<C, AddpoolInput> {
    return ClusterBuildStep.create<C, AddpoolInput>(
      actor,
      name,
      description,
      options,
      { kind: "KickerContractSteps.AddpoolInput", data },
      runAddpool
    )
  }

  /** Named runner — `sysio.kicker::addpool`, signed by `sysio`. */
  export async function runAddpool<C extends ClusterBuildContext>(
    ctx: C,
    input: AddpoolInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.kicker)
      .actions.addpool.invoke(input.data, {
        authorization: GovernanceAuthorization
      })
  }

  /** Input for {@link planSetpool} — the generated `kicker::setpool` data. */
  export interface SetpoolInput extends StepInput {
    readonly kind: "KickerContractSteps.SetpoolInput"
    readonly data: SysioContracts.SysioKickerSetpoolAction
  }

  /**
   * `sysio.kicker::setpool` — change one token's rate, minimum gift and daily
   * ceiling; the new rate prices the whole open interval. Signed by `sysio`.
   */
  export function planSetpool<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioKickerSetpoolAction
  ): ClusterBuildStep<C, SetpoolInput> {
    return ClusterBuildStep.create<C, SetpoolInput>(
      actor,
      name,
      description,
      options,
      { kind: "KickerContractSteps.SetpoolInput", data },
      runSetpool
    )
  }

  /** Named runner — `sysio.kicker::setpool`, signed by `sysio`. */
  export async function runSetpool<C extends ClusterBuildContext>(
    ctx: C,
    input: SetpoolInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.kicker)
      .actions.setpool.invoke(input.data, {
        authorization: GovernanceAuthorization
      })
  }
}
