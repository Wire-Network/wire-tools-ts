import { SysioContracts } from "@wireio/sdk-core"
import { Report } from "../../../../report/Report.js"
import { ClusterBuildContext } from "../../../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../../ClusterBuildStep.js"
import type { StepInput } from "../../../StepRunner.js"

const { SysioContractName } = SysioContracts

/** Steps for `sysio.tokens` actions (the OPP token + chain-token registry). */
export namespace TokensContractSteps {
  /** Input for {@link planRegtoken} — the generated `tokens::regtoken` data. */
  export interface RegtokenInput extends StepInput {
    readonly kind: "TokensContractSteps.RegtokenInput"
    readonly data: SysioContracts.SysioTokensRegtokenAction
  }

  /** `sysio.tokens::regtoken` — register one token (native / ERC-20 / SPL / LIQ). */
  export function planRegtoken<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioTokensRegtokenAction
  ): ClusterBuildStep<C, RegtokenInput> {
    return ClusterBuildStep.create<C, RegtokenInput>(
      actor,
      name,
      description,
      options,
      { kind: "TokensContractSteps.RegtokenInput", data },
      runRegtoken
    )
  }

  /** Named runner — `sysio.tokens::regtoken`. */
  export async function runRegtoken<C extends ClusterBuildContext>(
    ctx: C,
    input: RegtokenInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.tokens)
      .actions.regtoken.invoke(input.data)
  }

  /** Input for {@link planRegctok} — the generated `tokens::regctok` data. */
  export interface RegctokInput extends StepInput {
    readonly kind: "TokensContractSteps.RegctokInput"
    readonly data: SysioContracts.SysioTokensRegctokAction
  }

  /** `sysio.tokens::regctok` — register one `(chain, token)` binding. */
  export function planRegctok<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioTokensRegctokAction
  ): ClusterBuildStep<C, RegctokInput> {
    return ClusterBuildStep.create<C, RegctokInput>(
      actor,
      name,
      description,
      options,
      { kind: "TokensContractSteps.RegctokInput", data },
      runRegctok
    )
  }

  /** Named runner — `sysio.tokens::regctok`. */
  export async function runRegctok<C extends ClusterBuildContext>(
    ctx: C,
    input: RegctokInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.tokens)
      .actions.regctok.invoke(input.data)
  }
}
