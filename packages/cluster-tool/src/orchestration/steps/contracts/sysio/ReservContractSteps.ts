import { SysioContracts } from "@wireio/sdk-core"
import { WireClient } from "../../../../clients/wire/WireClient.js"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/**
 * Steps for `sysio.reserv` actions.
 *
 * The owner-fee actions are signed by the RESERVE'S OWNER (`WireClient.activeAuthorization`),
 * not by the contract. The owner is not part of either action's data (the contract reads it
 * off the row), so it rides the step input.
 */
export namespace ReservContractSteps {
  /** Input for {@link planRegreserve} — the generated `reserv::regreserve` data. */
  export interface RegreserveInput extends StepInput {
    readonly kind: "ReservContractSteps.RegreserveInput"
    readonly data: SysioContracts.SysioReservRegreserveAction
  }

  /** `sysio.reserv::regreserve` — seed one `(chain, token, reserve)` reserve book. */
  export function planRegreserve<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioReservRegreserveAction
  ): ClusterBuildStep<C, RegreserveInput> {
    return ClusterBuildStep.create<C, RegreserveInput>(
      actor,
      name,
      description,
      options,
      { kind: "ReservContractSteps.RegreserveInput", data },
      runRegreserve
    )
  }

  /** Named runner — `sysio.reserv::regreserve`. */
  export async function runRegreserve<C extends ClusterBuildContext>(
    ctx: C,
    input: RegreserveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.reserv)
      .actions.regreserve.invoke(input.data)
  }

  /** Input for {@link planSetconfig} — the generated `reserv::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "ReservContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioReservSetconfigAction
  }

  /**
   * `sysio.reserv::setconfig` — set the fee-routing config. Its one field,
   * `fee_emissions_share_bps`, is stage 2 of the swap-fee split: the share of
   * each fee's rewards pool sent to the `sysio` emissions treasury instead of
   * the batch-operator rewards bucket. Zero (the default) keeps every fee inside
   * `sysio.reserv` custody at settlement.
   */
  export function planSetconfig<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioReservSetconfigAction
  ): ClusterBuildStep<C, SetconfigInput> {
    return ClusterBuildStep.create<C, SetconfigInput>(
      actor,
      name,
      description,
      options,
      { kind: "ReservContractSteps.SetconfigInput", data },
      runSetconfig
    )
  }

  /** Named runner — `sysio.reserv::setconfig`. */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    input: SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.reserv)
      .actions.setconfig.invoke(input.data)
  }

  /** Input for {@link planSetrsvfee} — the generated `reserv::setrsvfee` data. */
  export interface SetrsvfeeInput extends StepInput {
    readonly kind: "ReservContractSteps.SetrsvfeeInput"
    readonly data: SysioContracts.SysioReservSetrsvfeeAction
    /** The reserve's owner — the required signer, absent from the action data. */
    readonly owner: string
  }

  /**
   * `sysio.reserv::setrsvfee` — set one reserve's owner fee, the independent
   * per-reserve fee its liquidity earns on every swap that draws from it. Signed
   * by the reserve's `owner`; the rate is `0` (charge nothing) or `[1, 9900]`.
   */
  export function planSetrsvfee<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioReservSetrsvfeeAction,
    owner: string
  ): ClusterBuildStep<C, SetrsvfeeInput> {
    return ClusterBuildStep.create<C, SetrsvfeeInput>(
      actor,
      name,
      description,
      options,
      { kind: "ReservContractSteps.SetrsvfeeInput", data, owner },
      runSetrsvfee
    )
  }

  /** Named runner — `sysio.reserv::setrsvfee`, signed by the reserve owner. */
  export async function runSetrsvfee<C extends ClusterBuildContext>(
    ctx: C,
    input: SetrsvfeeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.reserv)
      .actions.setrsvfee.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.owner)
      })
  }

  /** Input for {@link planClaimrsvfee} — the generated `reserv::claimrsvfee` data. */
  export interface ClaimrsvfeeInput extends StepInput {
    readonly kind: "ReservContractSteps.ClaimrsvfeeInput"
    readonly data: SysioContracts.SysioReservClaimrsvfeeAction
    /** The reserve's owner — the required signer AND the payout recipient. */
    readonly owner: string
  }

  /**
   * `sysio.reserv::claimrsvfee` — pay one reserve's accrued owner fee out to its
   * owner as real WIRE and zero the accrual. Signed by the reserve's `owner`.
   */
  export function planClaimrsvfee<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioReservClaimrsvfeeAction,
    owner: string
  ): ClusterBuildStep<C, ClaimrsvfeeInput> {
    return ClusterBuildStep.create<C, ClaimrsvfeeInput>(
      actor,
      name,
      description,
      options,
      { kind: "ReservContractSteps.ClaimrsvfeeInput", data, owner },
      runClaimrsvfee
    )
  }

  /** Named runner — `sysio.reserv::claimrsvfee`, signed by the reserve owner. */
  export async function runClaimrsvfee<C extends ClusterBuildContext>(
    ctx: C,
    input: ClaimrsvfeeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.reserv)
      .actions.claimrsvfee.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.owner)
      })
  }
}
