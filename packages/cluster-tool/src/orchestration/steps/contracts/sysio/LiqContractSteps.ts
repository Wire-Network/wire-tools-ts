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
 * Steps for `sysio.liq` actions — the shadow liq token.
 *
 * The contract-signed actions (`create`, `regliqpool`, `recredit`) ride the
 * client's default authorization, the contract account. `claim` is signed by
 * the holder named in its data. Sweeping parked shadow and desyndicating are
 * `sysio.synd`'s actions (`Steps.contracts.sysio.synd`).
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
  export function planCreate<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
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
  export function planRegliqpool<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
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

  /** Input for {@link planClaim} — the generated `liq::claim` data. */
  export interface ClaimInput extends StepInput {
    readonly kind: "LiqContractSteps.ClaimInput"
    readonly data: SysioContracts.SysioLiqClaimAction
  }

  /**
   * `sysio.liq::claim` — pay a holder every subunit of WIRE owed to their
   * shadow row and settle it at the current index. Signed by the holder.
   */
  export function planClaim<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
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

  /** Input for {@link planRecredit} — the generated `liq::recredit` data. */
  export interface RecreditInput extends StepInput {
    readonly kind: "LiqContractSteps.RecreditInput"
    readonly data: SysioContracts.SysioLiqRecreditAction
  }

  /**
   * `sysio.liq::recredit` — return shadow to a holder whose desyndication the
   * outpost skipped: it grows the supply and credits the holder's row. Only for
   * a release the outpost neither paid nor stored (`docs/sysio-synd.md`, the
   * recredit rule). Signed by the contract.
   */
  export function planRecredit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioLiqRecreditAction
  ): ClusterBuildStep<C, RecreditInput> {
    return ClusterBuildStep.create<C, RecreditInput>(
      actor,
      name,
      description,
      options,
      { kind: "LiqContractSteps.RecreditInput", data },
      runRecredit
    )
  }

  /** Named runner — `sysio.liq::recredit`. */
  export async function runRecredit<C extends ClusterBuildContext>(
    ctx: C,
    input: RecreditInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.liq)
      .actions.recredit.invoke(input.data)
  }
}
