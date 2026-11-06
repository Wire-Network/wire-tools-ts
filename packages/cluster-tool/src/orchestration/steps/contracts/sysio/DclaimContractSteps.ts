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
 * Steps for `sysio.dclaim` (distribution claims) actions. `claim` is signed by the claiming
 * account; every other action runs under the contract's own authority, the client's
 * default.
 */
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

  /** Input for {@link planImportseed} — the generated `sysio.dclaim::importseed` data. */
  export interface ImportseedInput extends StepInput {
    readonly kind: "DclaimContractSteps.ImportseedInput"
    readonly data: SysioContracts.SysioDclaimImportseedAction
  }

  /**
   * `sysio.dclaim::importseed` — credit pre-launch WIRE claims to native addresses of one
   * chain, held unmapped until each address links an account. Refused once the import is
   * sealed. Signed by the contract.
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

  /** Named runner — `sysio.dclaim::importseed`, signed by the contract. */
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

  /** Input for {@link planImportdone} — the generated `sysio.dclaim::importdone` data. */
  export interface ImportdoneInput extends StepInput {
    readonly kind: "DclaimContractSteps.ImportdoneInput"
    readonly data: SysioContracts.SysioDclaimImportdoneAction
  }

  /**
   * `sysio.dclaim::importdone` — seal the pre-launch claim import for good
   * (`cap_config.imported_complete`). Signed by the contract.
   */
  export function planImportdone<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioDclaimImportdoneAction
  ): ClusterBuildStep<C, ImportdoneInput> {
    return ClusterBuildStep.create<C, ImportdoneInput>(
      actor,
      name,
      description,
      options,
      { kind: "DclaimContractSteps.ImportdoneInput", data },
      runImportdone
    )
  }

  /** Named runner — `sysio.dclaim::importdone`, signed by the contract. */
  export async function runImportdone<C extends ClusterBuildContext>(
    ctx: C,
    input: ImportdoneInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.importdone.invoke(input.data)
  }

  /** Input for {@link planClaim} — the generated `sysio.dclaim::claim` data. */
  export interface ClaimInput extends StepInput {
    readonly kind: "DclaimContractSteps.ClaimInput"
    readonly data: SysioContracts.SysioDclaimClaimAction
  }

  /**
   * `sysio.dclaim::claim` — pay an account its whole pending claim in WIRE. Signed by the
   * account.
   */
  export function planClaim<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioDclaimClaimAction
  ): ClusterBuildStep<C, ClaimInput> {
    return ClusterBuildStep.create<C, ClaimInput>(
      actor,
      name,
      description,
      options,
      { kind: "DclaimContractSteps.ClaimInput", data },
      runClaim
    )
  }

  /** Named runner — `sysio.dclaim::claim`, signed by the claiming account. */
  export async function runClaim<C extends ClusterBuildContext>(
    ctx: C,
    input: ClaimInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.dclaim)
      .actions.claim.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.wire_account)
      })
  }
}
