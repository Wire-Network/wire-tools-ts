import { type PermissionLevelType, SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/** `sysio@active` — issue + transfer are signed by the issuer/sender `sysio`, not the token contract. */
const SysioActiveAuthorization: PermissionLevelType[] = [
  { actor: "sysio", permission: "active" }
]

/** Steps for `sysio.token` (the core token ledger) actions. */
export namespace TokenContractSteps {
  /** Input for {@link create} — the generated `token::create` data. */
  export interface CreateInput extends StepInput {
    readonly kind: "TokenContractSteps.CreateInput"
    readonly data: SysioContracts.SysioTokenCreateAction
  }

  /** `sysio.token::create` — create a token (authorized `sysio.token@active`). */
  export function create<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioTokenCreateAction
  ): ClusterBuildStep<C, CreateInput> {
    return ClusterBuildStep.create<C, CreateInput>(
      actor,
      name,
      description,
      options,
      { kind: "TokenContractSteps.CreateInput", data },
      runCreate
    )
  }

  /** Named runner — `sysio.token::create`. */
  export async function runCreate<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.getSysioContract(SysioContractName.token).actions.create.invoke(input.data)
  }

  /** Input for {@link issue} — the generated `token::issue` data. */
  export interface IssueInput extends StepInput {
    readonly kind: "TokenContractSteps.IssueInput"
    readonly data: SysioContracts.SysioTokenIssueAction
  }

  /** `sysio.token::issue` — issue supply, signed by the issuer `sysio@active`. */
  export function issue<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioTokenIssueAction
  ): ClusterBuildStep<C, IssueInput> {
    return ClusterBuildStep.create<C, IssueInput>(
      actor,
      name,
      description,
      options,
      { kind: "TokenContractSteps.IssueInput", data },
      runIssue
    )
  }

  /** Named runner — `sysio.token::issue` (authorized `sysio@active`). */
  export async function runIssue<C extends ClusterBuildContext>(
    ctx: C,
    input: IssueInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.token)
      .actions.issue.invoke(input.data, { authorization: SysioActiveAuthorization })
  }

  /** Input for {@link transfer} — the generated `token::transfer` data. */
  export interface TransferInput extends StepInput {
    readonly kind: "TokenContractSteps.TransferInput"
    readonly data: SysioContracts.SysioTokenTransferAction
  }

  /** `sysio.token::transfer` — transfer tokens, signed by the sender `sysio@active`. */
  export function transfer<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioTokenTransferAction
  ): ClusterBuildStep<C, TransferInput> {
    return ClusterBuildStep.create<C, TransferInput>(
      actor,
      name,
      description,
      options,
      { kind: "TokenContractSteps.TransferInput", data },
      runTransfer
    )
  }

  /** Named runner — `sysio.token::transfer` (authorized `sysio@active`). */
  export async function runTransfer<C extends ClusterBuildContext>(
    ctx: C,
    input: TransferInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.token)
      .actions.transfer.invoke(input.data, { authorization: SysioActiveAuthorization })
  }
}
