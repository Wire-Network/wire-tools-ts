import type { SysioContracts } from "@wireio/sdk-core"
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
  /** Input for {@link planCreateSystem}. */
  export interface CreateSystemInput extends StepInput {
    readonly kind: "AccountSteps.CreateSystemInput"
    /** The account to create: a `sysio.*` account, or a reserved delegate name prefix. */
    readonly account: string
    /** Its `active` authority; its `owner` is always `sysio@active`. */
    readonly active: SysioContracts.SysioSystemAuthorityType
  }

  /**
   * Create a system account whose `owner` is `sysio@active`: a `sysio.*`
   * account, or a reserved delegate name prefix.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param account - The account to create.
   * @param active - Its `active` authority: `sysio@active` by default; a
   *   governance authority starts with the unsatisfiable
   *   {@link WireSysioContractTool.sysioNullActiveAuthority} until
   *   `sysio.councl` writes its members, and a reserved name keeps it.
   * @returns The definition step.
   */
  export function planCreateSystem<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    active: SysioContracts.SysioSystemAuthorityType = WireSysioContractTool.sysioActiveAuthority()
  ): ClusterBuildStep<C, CreateSystemInput> {
    return ClusterBuildStep.create<C, CreateSystemInput>(
      actor,
      name,
      description,
      options,
      { kind: "AccountSteps.CreateSystemInput", account, active },
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
    await new WireSysioContractTool(ctx.wire).createSysioAccount(
      input.account,
      input.active
    )
  }

  /** Input for {@link planCreateKeyed}. */
  export interface CreateKeyedInput extends StepInput {
    readonly kind: "AccountSteps.CreateKeyedInput"
    readonly account: string
    readonly publicKey: string
    readonly creator: string
  }

  /** Create a keyed account (owner = active = `publicKey`), e.g. a producer. */
  export function planCreateKeyed<C extends ClusterBuildContext = ClusterBuildContext>(
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

  /** Input for {@link planRamGrant}. */
  export interface RamGrantInput extends StepInput {
    readonly kind: "AccountSteps.RamGrantInput"
    /** The account whose RAM limit is raised. */
    readonly account: string
    /** Bytes added to the account's current RAM limit. */
    readonly ramBytes: number
  }

  /**
   * Raise an account's RAM limit by `ramBytes`, as `sysio` (`sysio::setacctram`)
   * — for a system contract account whose own native permissions and action
   * links outgrow its code + abi allowance (`sysio.andon`).
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param account - The account whose RAM limit is raised.
   * @param ramBytes - Bytes added to the account's current RAM limit.
   * @returns The definition step.
   */
  export function planRamGrant<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    ramBytes: number
  ): ClusterBuildStep<C, RamGrantInput> {
    return ClusterBuildStep.create<C, RamGrantInput>(
      actor,
      name,
      description,
      options,
      { kind: "AccountSteps.RamGrantInput", account, ramBytes },
      runRamGrant
    )
  }

  /** Named runner — `WireClient.grantRam`. */
  export async function runRamGrant<C extends ClusterBuildContext>(
    ctx: C,
    input: RamGrantInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire.grantRam(input.account, input.ramBytes)
  }
}
