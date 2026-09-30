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
 * Steps for `sysio.liq` actions — the shadow liq token.
 *
 * The contract-signed actions (`create`, `regliqpool`) ride the client's default
 * authorization, the contract account. `setkicker` is governance's: the contract
 * requires the system account. The holder actions (`claim`, `desyndicate`) are
 * signed by the holder named in their data, and the permissionless `sweep` by
 * whichever account foots the CPU, which rides the step input.
 */
export namespace LiqContractSteps {
  /** Input for {@link planCreate} — the generated `liq::create` data. */
  export interface CreateInput extends StepInput {
    readonly kind: "LiqContractSteps.CreateInput"
    readonly data: SysioContracts.SysioLiqCreateAction
  }

  /**
   * `sysio.liq::create` — open one shadow symbol, bound to an active liq token
   * of the chain and token registries. Signed by the contract.
   */
  export function planCreate<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioLiqCreateAction
  ): ClusterBuildStep<C, CreateInput> {
    return ClusterBuildStep.create<C, CreateInput>(
      actor,
      name,
      description,
      options,
      { kind: "LiqContractSteps.CreateInput", data },
      runCreate
    )
  }

  /** Named runner — `sysio.liq::create`. */
  export async function runCreate<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.liq)
      .actions.create.invoke(input.data)
  }

  /** Input for {@link planSetkicker} — the generated `liq::setkicker` data. */
  export interface SetkickerInput extends StepInput {
    readonly kind: "LiqContractSteps.SetkickerInput"
    readonly data: SysioContracts.SysioLiqSetkickerAction
  }

  /**
   * `sysio.liq::setkicker` — set the T5 kicker folded into every yield intake,
   * in basis points of the intake. Governance's action: signed by the system
   * account, the authority council proposals execute as.
   */
  export function planSetkicker<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioLiqSetkickerAction
  ): ClusterBuildStep<C, SetkickerInput> {
    return ClusterBuildStep.create<C, SetkickerInput>(
      actor,
      name,
      description,
      options,
      { kind: "LiqContractSteps.SetkickerInput", data },
      runSetkicker
    )
  }

  /** Named runner — `sysio.liq::setkicker`, signed by the system account. */
  export async function runSetkicker<C extends ClusterBuildContext>(
    ctx: C,
    input: SetkickerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.liq)
      .actions.setkicker.invoke(input.data, {
        authorization: WireClient.activeAuthorization(
          SysioContractAccount[SysioContractName.system]
        )
      })
  }

  /** Input for {@link planRegliqpool} — the generated `liq::regliqpool` data. */
  export interface RegliqpoolInput extends StepInput {
    readonly kind: "LiqContractSteps.RegliqpoolInput"
    readonly data: SysioContracts.SysioLiqRegliqpoolAction
  }

  /**
   * `sysio.liq::regliqpool` — seed one shadow's yield pool on `sysio.swap`: mint
   * the pool's shadow to the system account, deposit both seeds, create the
   * pair with the shadow as its yield leg, and set its tick pacing. The contract
   * gates it to the epoch-0 bootstrap window, so it only ever runs
   * pre-EpochBootstrap. Signed by the contract.
   */
  export function planRegliqpool<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioLiqRegliqpoolAction
  ): ClusterBuildStep<C, RegliqpoolInput> {
    return ClusterBuildStep.create<C, RegliqpoolInput>(
      actor,
      name,
      description,
      options,
      { kind: "LiqContractSteps.RegliqpoolInput", data },
      runRegliqpool
    )
  }

  /** Named runner — `sysio.liq::regliqpool`. */
  export async function runRegliqpool<C extends ClusterBuildContext>(
    ctx: C,
    input: RegliqpoolInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.liq)
      .actions.regliqpool.invoke(input.data)
  }

  /** Input for {@link planSweep} — the generated `liq::sweep` data plus the CPU payer. */
  export interface SweepInput extends StepInput {
    readonly kind: "LiqContractSteps.SweepInput"
    readonly data: SysioContracts.SysioLiqSweepAction
    /** The account whose signature carries the permissionless push. */
    readonly signer: string
  }

  /**
   * `sysio.liq::sweep` — deliver the shadow parked against an account's link
   * for a chain family. Permissionless: `signer` only foots the CPU.
   */
  export function planSweep<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioLiqSweepAction,
    signer: string
  ): ClusterBuildStep<C, SweepInput> {
    return ClusterBuildStep.create<C, SweepInput>(
      actor,
      name,
      description,
      options,
      { kind: "LiqContractSteps.SweepInput", data, signer },
      runSweep
    )
  }

  /** Named runner — `sysio.liq::sweep`, signed by the CPU payer. */
  export async function runSweep<C extends ClusterBuildContext>(
    ctx: C,
    input: SweepInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.liq)
      .actions.sweep.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.signer)
      })
  }

  /** Input for {@link planClaim} — the generated `liq::claim` data. */
  export interface ClaimInput extends StepInput {
    readonly kind: "LiqContractSteps.ClaimInput"
    readonly data: SysioContracts.SysioLiqClaimAction
  }

  /**
   * `sysio.liq::claim` — pay a holder every subunit of WIRE owed to their
   * shadow row and settle it at the current index. Signed by the holder.
   */
  export function planClaim<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioLiqClaimAction
  ): ClusterBuildStep<C, ClaimInput> {
    return ClusterBuildStep.create<C, ClaimInput>(
      actor,
      name,
      description,
      options,
      { kind: "LiqContractSteps.ClaimInput", data },
      runClaim
    )
  }

  /** Named runner — `sysio.liq::claim`, signed by the holder. */
  export async function runClaim<C extends ClusterBuildContext>(
    ctx: C,
    input: ClaimInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.liq)
      .actions.claim.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.holder)
      })
  }

  /** Input for {@link planDesyndicate} — the generated `liq::desyndicate` data. */
  export interface DesyndicateInput extends StepInput {
    readonly kind: "LiqContractSteps.DesyndicateInput"
    readonly data: SysioContracts.SysioLiqDesyndicateAction
  }

  /**
   * `sysio.liq::desyndicate` — settle, burn, and queue `DESYNDICATE_LIQ` for
   * the outpost to pay the holder's linked key inline. Signed by the holder,
   * who must be AuthX-linked for the token's chain.
   */
  export function planDesyndicate<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioLiqDesyndicateAction
  ): ClusterBuildStep<C, DesyndicateInput> {
    return ClusterBuildStep.create<C, DesyndicateInput>(
      actor,
      name,
      description,
      options,
      { kind: "LiqContractSteps.DesyndicateInput", data },
      runDesyndicate
    )
  }

  /** Named runner — `sysio.liq::desyndicate`, signed by the holder. */
  export async function runDesyndicate<C extends ClusterBuildContext>(
    ctx: C,
    input: DesyndicateInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.liq)
      .actions.desyndicate.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.holder)
      })
  }
}
