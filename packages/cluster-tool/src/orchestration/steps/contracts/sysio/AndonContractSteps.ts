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
 * Steps for `sysio.andon` actions — the depot's emergency stop (the Andon cord).
 *
 * `setpanic` and `addpuller` are governance's: the contract requires the system
 * account. `pull` and `clear` are signed by the `actor` named in their data —
 * the contract admits `sysio`, the panic account and (for `pull`) a registered
 * puller.
 */
export namespace AndonContractSteps {
  /** Input for {@link planSetpanic} — the generated `sysio.andon::setpanic` data. */
  export interface SetpanicInput extends StepInput {
    readonly kind: "AndonContractSteps.SetpanicInput"
    readonly data: SysioContracts.SysioAndonSetpanicAction
  }

  /**
   * `sysio.andon::setpanic` — name the panic account, which may pull and clear
   * the cord. The account must exist. Signed by the system account.
   */
  export function planSetpanic<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioAndonSetpanicAction
  ): ClusterBuildStep<C, SetpanicInput> {
    return ClusterBuildStep.create<C, SetpanicInput>(
      actor,
      name,
      description,
      options,
      { kind: "AndonContractSteps.SetpanicInput", data },
      runSetpanic
    )
  }

  /** Named runner — `sysio.andon::setpanic`, signed by the system account. */
  export async function runSetpanic<C extends ClusterBuildContext>(
    ctx: C,
    input: SetpanicInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.andon)
      .actions.setpanic.invoke(input.data, {
        authorization: WireClient.activeAuthorization(
          SysioContractAccount[SysioContractName.system]
        )
      })
  }

  /** Input for {@link planAddpuller} — the generated `sysio.andon::addpuller` data. */
  export interface AddpullerInput extends StepInput {
    readonly kind: "AndonContractSteps.AddpullerInput"
    readonly data: SysioContracts.SysioAndonAddpullerAction
  }

  /**
   * `sysio.andon::addpuller` — register a contract that may pull the cord on a
   * fault it detects (`sysio.synd` on a custody shortfall). Signed by the system
   * account.
   */
  export function planAddpuller<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioAndonAddpullerAction
  ): ClusterBuildStep<C, AddpullerInput> {
    return ClusterBuildStep.create<C, AddpullerInput>(
      actor,
      name,
      description,
      options,
      { kind: "AndonContractSteps.AddpullerInput", data },
      runAddpuller
    )
  }

  /** Named runner — `sysio.andon::addpuller`, signed by the system account. */
  export async function runAddpuller<C extends ClusterBuildContext>(
    ctx: C,
    input: AddpullerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.andon)
      .actions.addpuller.invoke(input.data, {
        authorization: WireClient.activeAuthorization(
          SysioContractAccount[SysioContractName.system]
        )
      })
  }

  /** Input for {@link planPull} — the generated `sysio.andon::pull` data. */
  export interface PullInput extends StepInput {
    readonly kind: "AndonContractSteps.PullInput"
    readonly data: SysioContracts.SysioAndonPullAction
  }

  /**
   * `sysio.andon::pull` — pull the cord: every contract that reads it stops
   * moving funds out until it is cleared. Signed by the `actor` in the data.
   */
  export function planPull<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioAndonPullAction
  ): ClusterBuildStep<C, PullInput> {
    return ClusterBuildStep.create<C, PullInput>(
      actor,
      name,
      description,
      options,
      { kind: "AndonContractSteps.PullInput", data },
      runPull
    )
  }

  /** Named runner — `sysio.andon::pull`, signed by the pulling actor. */
  export async function runPull<C extends ClusterBuildContext>(
    ctx: C,
    input: PullInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.andon)
      .actions.pull.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.actor)
      })
  }

  /** Input for {@link planClear} — the generated `sysio.andon::clear` data. */
  export interface ClearInput extends StepInput {
    readonly kind: "AndonContractSteps.ClearInput"
    readonly data: SysioContracts.SysioAndonClearAction
  }

  /**
   * `sysio.andon::clear` — clear the cord. Signed by the `actor` in the data:
   * the system account or the panic account.
   */
  export function planClear<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioAndonClearAction
  ): ClusterBuildStep<C, ClearInput> {
    return ClusterBuildStep.create<C, ClearInput>(
      actor,
      name,
      description,
      options,
      { kind: "AndonContractSteps.ClearInput", data },
      runClear
    )
  }

  /** Named runner — `sysio.andon::clear`, signed by the clearing actor. */
  export async function runClear<C extends ClusterBuildContext>(
    ctx: C,
    input: ClearInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.andon)
      .actions.clear.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.actor)
      })
  }
}
