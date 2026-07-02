import { WireSysioContractTool } from "../../tools/wire/WireSysioContractTool.js"
import { Report } from "../../report/Report.js"
import { ClusterBuildContext } from "../ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../ClusterBuildStep.js"
import type { StepInput } from "../StepRunner.js"

/** Steps that create accounts during bootstrap. */
export namespace AccountSteps {
  /** Input for {@link createSystem}. */
  export interface CreateSystemInput extends StepInput {
    readonly kind: "AccountSteps.CreateSystemInput"
    readonly account: string
  }

  /** Create a `sysio.*` system account governed solely by `sysio@active`. */
  export function createSystem<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string
  ): ClusterBuildStep<C, CreateSystemInput> {
    return ClusterBuildStep.create<C, CreateSystemInput>(
      actor,
      name,
      description,
      options,
      { kind: "AccountSteps.CreateSystemInput", account },
      runCreateSystem
    )
  }

  /** Named runner — `WireSysioContractTool.createSysioAccount`. */
  export async function runCreateSystem<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateSystemInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await new WireSysioContractTool(ctx.wire).createSysioAccount(input.account)
  }

  /** Input for {@link createKeyed}. */
  export interface CreateKeyedInput extends StepInput {
    readonly kind: "AccountSteps.CreateKeyedInput"
    readonly account: string
    readonly publicKey: string
    readonly creator: string
  }

  /** Create a keyed account (owner = active = `publicKey`), e.g. a producer. */
  export function createKeyed<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    publicKey: string,
    creator: string = "sysio"
  ): ClusterBuildStep<C, CreateKeyedInput> {
    return ClusterBuildStep.create<C, CreateKeyedInput>(
      actor,
      name,
      description,
      options,
      { kind: "AccountSteps.CreateKeyedInput", account, publicKey, creator },
      runCreateKeyed
    )
  }

  /** Named runner — `WireClient.createAccount`. */
  export async function runCreateKeyed<C extends ClusterBuildContext>(
    ctx: C,
    input: CreateKeyedInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.createAccount(
      input.creator,
      input.account,
      input.publicKey,
      input.publicKey
    )
  }
}
