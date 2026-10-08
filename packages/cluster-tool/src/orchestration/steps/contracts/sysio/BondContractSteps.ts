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
 * Steps for `sysio.bond` actions — the depot's underwriting contract.
 *
 * `setconfig` and the rulings (`rslvvalid`, `rslvinvalid`) are governance's:
 * the contract requires the system account. `accept` is signed by the
 * underwriter named in its data. `approve`, `claim`, `prune` and `sweepyield`
 * are permissionless: `signer` only foots the CPU and rides the step input.
 * The issuer actions (`request`, `hold`, `addbounty`) have no Step: `sysio.synd`
 * sends them for its envelopes.
 */
export namespace BondContractSteps {
  /** Input for {@link planSetconfig} — the generated `sysio.bond::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "BondContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioBondSetconfigAction
  }

  /**
   * `sysio.bond::setconfig` — set the hold bond, in basis points of a request's
   * covered amount. Signed by the system account.
   */
  export function planSetconfig<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBondSetconfigAction
  ): ClusterBuildStep<C, SetconfigInput> {
    return ClusterBuildStep.create<C, SetconfigInput>(
      actor,
      name,
      description,
      options,
      { kind: "BondContractSteps.SetconfigInput", data },
      runSetconfig
    )
  }

  /** Named runner — `sysio.bond::setconfig`, signed by the system account. */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    input: SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bond)
      .actions.setconfig.invoke(input.data, {
        authorization: WireClient.activeAuthorization(
          SysioContractAccount[SysioContractName.system]
        )
      })
  }

  /** Input for {@link planAccept} — the generated `sysio.bond::accept` data. */
  export interface AcceptInput extends StepInput {
    readonly kind: "BondContractSteps.AcceptInput"
    readonly data: SysioContracts.SysioBondAcceptAction
  }

  /**
   * `sysio.bond::accept` — bond part or all of a request's uncovered amount. An
   * amount above the remainder is reduced to it. Signed by the underwriter.
   */
  export function planAccept<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBondAcceptAction
  ): ClusterBuildStep<C, AcceptInput> {
    return ClusterBuildStep.create<C, AcceptInput>(
      actor,
      name,
      description,
      options,
      { kind: "BondContractSteps.AcceptInput", data },
      runAccept
    )
  }

  /** Named runner — `sysio.bond::accept`, signed by the underwriter. */
  export async function runAccept<C extends ClusterBuildContext>(
    ctx: C,
    input: AcceptInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bond)
      .actions.accept.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.underwriter)
      })
  }

  /** Input for {@link planApprove} — the generated `sysio.bond::approve` data plus the CPU payer. */
  export interface ApproveInput extends StepInput {
    readonly kind: "BondContractSteps.ApproveInput"
    readonly data: SysioContracts.SysioBondApproveAction
    /** The account whose signature carries the permissionless push. */
    readonly signer: string
  }

  /**
   * `sysio.bond::approve` — approve a BONDED request whose challenge window has
   * passed with no hold. Permissionless: `signer` only foots the CPU.
   */
  export function planApprove<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBondApproveAction,
    signer: string
  ): ClusterBuildStep<C, ApproveInput> {
    return ClusterBuildStep.create<C, ApproveInput>(
      actor,
      name,
      description,
      options,
      { kind: "BondContractSteps.ApproveInput", data, signer },
      runApprove
    )
  }

  /** Named runner — `sysio.bond::approve`, signed by the CPU payer. */
  export async function runApprove<C extends ClusterBuildContext>(
    ctx: C,
    input: ApproveInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bond)
      .actions.approve.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.signer)
      })
  }

  /** Input for {@link planRslvvalid} — the generated `sysio.bond::rslvvalid` data. */
  export interface RslvvalidInput extends StepInput {
    readonly kind: "BondContractSteps.RslvvalidInput"
    readonly data: SysioContracts.SysioBondRslvvalidAction
  }

  /**
   * `sysio.bond::rslvvalid` — rule a request VALID. Signed by the system
   * account.
   */
  export function planRslvvalid<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBondRslvvalidAction
  ): ClusterBuildStep<C, RslvvalidInput> {
    return ClusterBuildStep.create<C, RslvvalidInput>(
      actor,
      name,
      description,
      options,
      { kind: "BondContractSteps.RslvvalidInput", data },
      runRslvvalid
    )
  }

  /** Named runner — `sysio.bond::rslvvalid`, signed by the system account. */
  export async function runRslvvalid<C extends ClusterBuildContext>(
    ctx: C,
    input: RslvvalidInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bond)
      .actions.rslvvalid.invoke(input.data, {
        authorization: WireClient.activeAuthorization(
          SysioContractAccount[SysioContractName.system]
        )
      })
  }

  /** Input for {@link planRslvinvalid} — the generated `sysio.bond::rslvinvalid` data. */
  export interface RslvinvalidInput extends StepInput {
    readonly kind: "BondContractSteps.RslvinvalidInput"
    readonly data: SysioContracts.SysioBondRslvinvalidAction
  }

  /**
   * `sysio.bond::rslvinvalid` — rule a request INVALID: its bonds become the
   * issuer's forfeit. Signed by the system account.
   */
  export function planRslvinvalid<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBondRslvinvalidAction
  ): ClusterBuildStep<C, RslvinvalidInput> {
    return ClusterBuildStep.create<C, RslvinvalidInput>(
      actor,
      name,
      description,
      options,
      { kind: "BondContractSteps.RslvinvalidInput", data },
      runRslvinvalid
    )
  }

  /** Named runner — `sysio.bond::rslvinvalid`, signed by the system account. */
  export async function runRslvinvalid<C extends ClusterBuildContext>(
    ctx: C,
    input: RslvinvalidInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bond)
      .actions.rslvinvalid.invoke(input.data, {
        authorization: WireClient.activeAuthorization(
          SysioContractAccount[SysioContractName.system]
        )
      })
  }

  /** Input for {@link planClaim} — the generated `sysio.bond::claim` data plus the CPU payer. */
  export interface ClaimInput extends StepInput {
    readonly kind: "BondContractSteps.ClaimInput"
    readonly data: SysioContracts.SysioBondClaimAction
    /** The account whose signature carries the permissionless push. */
    readonly signer: string
  }

  /**
   * `sysio.bond::claim` — pay `account` what the request owes it. Anyone may
   * send it for any account: `signer` only foots the CPU.
   */
  export function planClaim<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBondClaimAction,
    signer: string
  ): ClusterBuildStep<C, ClaimInput> {
    return ClusterBuildStep.create<C, ClaimInput>(
      actor,
      name,
      description,
      options,
      { kind: "BondContractSteps.ClaimInput", data, signer },
      runClaim
    )
  }

  /** Named runner — `sysio.bond::claim`, signed by the CPU payer. */
  export async function runClaim<C extends ClusterBuildContext>(
    ctx: C,
    input: ClaimInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bond)
      .actions.claim.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.signer)
      })
  }

  /** Input for {@link planPrune} — the generated `sysio.bond::prune` data plus the CPU payer. */
  export interface PruneInput extends StepInput {
    readonly kind: "BondContractSteps.PruneInput"
    readonly data: SysioContracts.SysioBondPruneAction
    /** The account whose signature carries the permissionless push. */
    readonly signer: string
  }

  /**
   * `sysio.bond::prune` — erase settled requests ruled at least the retention
   * period ago. Permissionless: `signer` only foots the CPU.
   */
  export function planPrune<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBondPruneAction,
    signer: string
  ): ClusterBuildStep<C, PruneInput> {
    return ClusterBuildStep.create<C, PruneInput>(
      actor,
      name,
      description,
      options,
      { kind: "BondContractSteps.PruneInput", data, signer },
      runPrune
    )
  }

  /** Named runner — `sysio.bond::prune`, signed by the CPU payer. */
  export async function runPrune<C extends ClusterBuildContext>(
    ctx: C,
    input: PruneInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bond)
      .actions.prune.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.signer)
      })
  }

  /** Input for {@link planSweepyield} — the generated `sysio.bond::sweepyield` data plus the CPU payer. */
  export interface SweepyieldInput extends StepInput {
    readonly kind: "BondContractSteps.SweepyieldInput"
    readonly data: SysioContracts.SysioBondSweepyieldAction
    /** The account whose signature carries the permissionless push. */
    readonly signer: string
  }

  /**
   * `sysio.bond::sweepyield` — pull the WIRE the contract's shadow holdings
   * earned on `sysio.liq`. Permissionless: `signer` only foots the CPU.
   */
  export function planSweepyield<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBondSweepyieldAction,
    signer: string
  ): ClusterBuildStep<C, SweepyieldInput> {
    return ClusterBuildStep.create<C, SweepyieldInput>(
      actor,
      name,
      description,
      options,
      { kind: "BondContractSteps.SweepyieldInput", data, signer },
      runSweepyield
    )
  }

  /** Named runner — `sysio.bond::sweepyield`, signed by the CPU payer. */
  export async function runSweepyield<C extends ClusterBuildContext>(
    ctx: C,
    input: SweepyieldInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bond)
      .actions.sweepyield.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.signer)
      })
  }
}
