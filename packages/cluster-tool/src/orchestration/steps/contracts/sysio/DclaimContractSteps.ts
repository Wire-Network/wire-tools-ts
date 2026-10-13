import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.dclaim` (distribution claims) actions. */
export namespace DclaimContractSteps {
  /** `sysio.dclaim::setconfig` — initialize the `cap_config` singleton (idempotent). */
  export function planSetconfig<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runSetconfig
    )
  }

  /** Named runner — `sysio.dclaim::setconfig` (empty payload). */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.setconfig.invoke({})
  }

  /** Input for {@link planImportseed} — the generated `dclaim::importseed` data. */
  export interface ImportseedInput extends StepInput {
    readonly kind: "DclaimContractSteps.ImportseedInput"
    readonly data: SysioContracts.SysioDclaimImportseedAction
  }

  /**
   * `sysio.dclaim::importseed` — push ONE batch of pre-launch pretoken credits
   * (one write per step). Refused once `importdone` has sealed the import.
   * Signed by the contract.
   */
  export function planImportseed<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioDclaimImportseedAction
  ): ClusterBuildStep<C, ImportseedInput> {
    return ClusterBuildStep.create<C, ImportseedInput>(
      actor,
      name,
      description,
      options,
      { kind: "DclaimContractSteps.ImportseedInput", data },
      runImportseed
    )
  }

  /** Named runner — `sysio.dclaim::importseed`. */
  export async function runImportseed<C extends ClusterBuildContext>(
    ctx: C,
    input: ImportseedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.importseed.invoke(input.data)
  }

  /** `sysio.dclaim::importdone` — seal the pre-launch import (one-shot, empty payload). */
  export function planImportdone<C extends ClusterBuildContext = ClusterBuildContext>(
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
      runImportdone
    )
  }

  /** Named runner — `sysio.dclaim::importdone` (empty payload). */
  export async function runImportdone<C extends ClusterBuildContext>(
    ctx: C,
    _input: null,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.importdone.invoke({})
  }
}
