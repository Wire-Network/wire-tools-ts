import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/**
 * Steps for `sysio.bios` actions — the minimal bootstrap contract on the `sysio`
 * account BEFORE `sysio.system` is deployed. `setfinalizer` (BLS finality) is
 * bios-only; `newaccount` / `setpriv` here are the pre-ROA (transiently-unlimited)
 * variants — post-ROA use `Steps.contracts.sysio.system.*`.
 */
export namespace BiosContractSteps {
  /** Input for {@link setfinalizer} — the generated `bios::setfinalizer` data. */
  export interface SetfinalizerInput extends StepInput {
    readonly kind: "BiosContractSteps.SetfinalizerInput"
    readonly data: SysioContracts.SysioBiosSetfinalizerAction
  }

  /** `sysio.bios::setfinalizer` — activate BLS instant finality with a policy. */
  export function setfinalizer<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBiosSetfinalizerAction
  ): ClusterBuildStep<C, SetfinalizerInput> {
    return ClusterBuildStep.create<C, SetfinalizerInput>(
      actor,
      name,
      description,
      options,
      { kind: "BiosContractSteps.SetfinalizerInput", data },
      runSetfinalizer
    )
  }

  /** Named runner — `sysio.bios::setfinalizer`. */
  export async function runSetfinalizer<C extends ClusterBuildContext>(
    ctx: C,
    input: SetfinalizerInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bios)
      .actions.setfinalizer.invoke(input.data)
  }

  /** Input for {@link newaccount} — the generated `bios::newaccount` data. */
  export interface NewaccountInput extends StepInput {
    readonly kind: "BiosContractSteps.NewaccountInput"
    readonly data: SysioContracts.SysioBiosNewaccountAction
  }

  /** `sysio.bios::newaccount` — create a bring-up account (pre-ROA, transiently unlimited). */
  export function newaccount<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBiosNewaccountAction
  ): ClusterBuildStep<C, NewaccountInput> {
    return ClusterBuildStep.create<C, NewaccountInput>(
      actor,
      name,
      description,
      options,
      { kind: "BiosContractSteps.NewaccountInput", data },
      runNewaccount
    )
  }

  /** Named runner — `sysio.bios::newaccount`. */
  export async function runNewaccount<C extends ClusterBuildContext>(
    ctx: C,
    input: NewaccountInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bios)
      .actions.newaccount.invoke(input.data)
  }

  /** Input for {@link setpriv} — the generated `bios::setpriv` data. */
  export interface SetprivInput extends StepInput {
    readonly kind: "BiosContractSteps.SetprivInput"
    readonly data: SysioContracts.SysioBiosSetprivAction
  }

  /** `sysio.bios::setpriv` — mark an account privileged (pre-ROA). */
  export function setpriv<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBiosSetprivAction
  ): ClusterBuildStep<C, SetprivInput> {
    return ClusterBuildStep.create<C, SetprivInput>(
      actor,
      name,
      description,
      options,
      { kind: "BiosContractSteps.SetprivInput", data },
      runSetpriv
    )
  }

  /** Named runner — `sysio.bios::setpriv`. */
  export async function runSetpriv<C extends ClusterBuildContext>(
    ctx: C,
    input: SetprivInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bios)
      .actions.setpriv.invoke(input.data)
  }

  /** Input for {@link setprodkeys} — the generated `bios::setprodkeys` data. */
  export interface SetprodkeysInput extends StepInput {
    readonly kind: "BiosContractSteps.SetprodkeysInput"
    readonly data: SysioContracts.SysioBiosSetprodkeysAction
  }

  /** `sysio.bios::setprodkeys` — set the producer schedule (pre-ROA). */
  export function setprodkeys<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioBiosSetprodkeysAction
  ): ClusterBuildStep<C, SetprodkeysInput> {
    return ClusterBuildStep.create<C, SetprodkeysInput>(
      actor,
      name,
      description,
      options,
      { kind: "BiosContractSteps.SetprodkeysInput", data },
      runSetprodkeys
    )
  }

  /** Named runner — `sysio.bios::setprodkeys`. */
  export async function runSetprodkeys<C extends ClusterBuildContext>(
    ctx: C,
    input: SetprodkeysInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.bios)
      .actions.setprodkeys.invoke(input.data)
  }
}
