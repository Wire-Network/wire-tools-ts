import { SysioContracts } from "@wireio/sdk-core"
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
 * Pull and clear declare their linked native permissions. The signer must satisfy
 * the delegated authority configured during bootstrap.
 */
export namespace AndonContractSteps {
  /** Native child permissions linked to the corresponding Andon action. */
  export enum Permission {
    pull = "pull",
    clear = "clear"
  }

  /** Input for {@link planPull} — the generated `sysio.andon::pull` data. */
  export interface PullInput extends StepInput {
    readonly kind: "AndonContractSteps.PullInput"
    readonly data: SysioContracts.SysioAndonPullAction
  }

  /**
   * `sysio.andon::pull` — pull the cord: every contract that reads it stops
   * moving funds out until it is cleared. Authorized by the delegated pull permission.
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

  /** Named runner — `sysio.andon::pull`, declaring the linked pull permission. */
  export async function runPull<C extends ClusterBuildContext>(
    ctx: C,
    input: PullInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.andon)
      .actions.pull.invoke(input.data, {
        authorization: [
          {
            actor: SysioContractAccount[SysioContractName.andon],
            permission: Permission.pull
          }
        ]
      })
  }

  /** Input for {@link planClear} — the generated `sysio.andon::clear` data. */
  export interface ClearInput extends StepInput {
    readonly kind: "AndonContractSteps.ClearInput"
    readonly data: SysioContracts.SysioAndonClearAction
  }

  /**
   * `sysio.andon::clear` — clear the cord. Authorized by the delegated clear permission.
   */
  export function planClear<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
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

  /** Named runner — `sysio.andon::clear`, declaring the linked clear permission. */
  export async function runClear<C extends ClusterBuildContext>(
    ctx: C,
    input: ClearInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.andon)
      .actions.clear.invoke(input.data, {
        authorization: [
          {
            actor: SysioContractAccount[SysioContractName.andon],
            permission: Permission.clear
          }
        ]
      })
  }
}
