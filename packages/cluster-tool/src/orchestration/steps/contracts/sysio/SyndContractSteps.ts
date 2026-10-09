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
 * Steps for `sysio.synd` actions — the depot's syndication contract, the only
 * account that mints and burns in `sysio.liq`.
 *
 * `setconfig` and `dropenv` are governance's: the contract requires the system
 * account. `importsynd` and `importdone` run under the contract's own
 * authority, the client's default. `challenge` is signed by the challenger and
 * `desyndicate` by the holder named in their data. `crank`, `sweep` and
 * `sweepyield` are permissionless: `signer` only foots the CPU and rides the
 * step input. The intake actions (`onsynd`, `onyield`, `closeenv`) and
 * `linkswept` have no Step: `sysio.msgch` and `sysio.authex` send them.
 */
export namespace SyndContractSteps {
  /** Input for {@link planSetconfig} — the generated `sysio.synd::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "SyndContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioSyndSetconfigAction
  }

  /**
   * `sysio.synd::setconfig` — replace one `(outpost, token)` pair's rules: the
   * fees, both buckets, the challenge window, the bounty and the challenge
   * charge. Signed by the system account.
   */
  export function planSetconfig<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSyndSetconfigAction
  ): ClusterBuildStep<C, SetconfigInput> {
    return ClusterBuildStep.create<C, SetconfigInput>(
      actor,
      name,
      description,
      options,
      { kind: "SyndContractSteps.SetconfigInput", data },
      runSetconfig
    )
  }

  /** Named runner — `sysio.synd::setconfig`, signed by the system account. */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    input: SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .actions.setconfig.invoke(input.data, {
        authorization: WireClient.activeAuthorization(
          SysioContractAccount[SysioContractName.system]
        )
      })
  }

  /** Input for {@link planCrank} — the generated `sysio.synd::crank` data plus the CPU payer. */
  export interface CrankInput extends StepInput {
    readonly kind: "SyndContractSteps.CrankInput"
    readonly data: SysioContracts.SysioSyndCrankAction
    /** The account whose signature carries the permissionless push. */
    readonly signer: string
  }

  /**
   * `sysio.synd::crank` — run one step of the release queue with a budget of
   * `limit`. Permissionless and never throwing: `signer` only foots the CPU.
   */
  export function planCrank<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSyndCrankAction,
    signer: string
  ): ClusterBuildStep<C, CrankInput> {
    return ClusterBuildStep.create<C, CrankInput>(
      actor,
      name,
      description,
      options,
      { kind: "SyndContractSteps.CrankInput", data, signer },
      runCrank
    )
  }

  /** Named runner — `sysio.synd::crank`, signed by the CPU payer. */
  export async function runCrank<C extends ClusterBuildContext>(
    ctx: C,
    input: CrankInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .actions.crank.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.signer)
      })
  }

  /** Input for {@link planChallenge} — the generated `sysio.synd::challenge` data. */
  export interface ChallengeInput extends StepInput {
    readonly kind: "SyndContractSteps.ChallengeInput"
    readonly data: SysioContracts.SysioSyndChallengeAction
  }

  /**
   * `sysio.synd::challenge` — hold an envelope's request until `sysio` rules,
   * paying the hold bond plus the pair's `challenge_extra`. Signed by the
   * challenger.
   */
  export function planChallenge<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSyndChallengeAction
  ): ClusterBuildStep<C, ChallengeInput> {
    return ClusterBuildStep.create<C, ChallengeInput>(
      actor,
      name,
      description,
      options,
      { kind: "SyndContractSteps.ChallengeInput", data },
      runChallenge
    )
  }

  /** Named runner — `sysio.synd::challenge`, signed by the challenger. */
  export async function runChallenge<C extends ClusterBuildContext>(
    ctx: C,
    input: ChallengeInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .actions.challenge.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.challenger)
      })
  }

  /** Input for {@link planDropenv} — the generated `sysio.synd::dropenv` data. */
  export interface DropenvInput extends StepInput {
    readonly kind: "SyndContractSteps.DropenvInput"
    readonly data: SysioContracts.SysioSyndDropenvAction
  }

  /**
   * `sysio.synd::dropenv` — burn and close an OPEN or WAITING envelope with no
   * request issued. Signed by the system account.
   */
  export function planDropenv<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSyndDropenvAction
  ): ClusterBuildStep<C, DropenvInput> {
    return ClusterBuildStep.create<C, DropenvInput>(
      actor,
      name,
      description,
      options,
      { kind: "SyndContractSteps.DropenvInput", data },
      runDropenv
    )
  }

  /** Named runner — `sysio.synd::dropenv`, signed by the system account. */
  export async function runDropenv<C extends ClusterBuildContext>(
    ctx: C,
    input: DropenvInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .actions.dropenv.invoke(input.data, {
        authorization: WireClient.activeAuthorization(
          SysioContractAccount[SysioContractName.system]
        )
      })
  }

  /** Input for {@link planDesyndicate} — the generated `sysio.synd::desyndicate` data. */
  export interface DesyndicateInput extends StepInput {
    readonly kind: "SyndContractSteps.DesyndicateInput"
    readonly data: SysioContracts.SysioSyndDesyndicateAction
  }

  /**
   * `sysio.synd::desyndicate` — take shadow from the holder's own row, keep the
   * fee, burn the rest and queue `DESYNDICATE_LIQ` for the outpost to pay the
   * holder's linked key. Signed by the holder, who must be AuthX-linked for the
   * token's chain.
   */
  export function planDesyndicate<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSyndDesyndicateAction
  ): ClusterBuildStep<C, DesyndicateInput> {
    return ClusterBuildStep.create<C, DesyndicateInput>(
      actor,
      name,
      description,
      options,
      { kind: "SyndContractSteps.DesyndicateInput", data },
      runDesyndicate
    )
  }

  /** Named runner — `sysio.synd::desyndicate`, signed by the holder. */
  export async function runDesyndicate<C extends ClusterBuildContext>(
    ctx: C,
    input: DesyndicateInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .actions.desyndicate.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.holder)
      })
  }

  /** Input for {@link planSweep} — the generated `sysio.synd::sweep` data plus the CPU payer. */
  export interface SweepInput extends StepInput {
    readonly kind: "SyndContractSteps.SweepInput"
    readonly data: SysioContracts.SysioSyndSweepAction
    /** The account whose signature carries the permissionless push. */
    readonly signer: string
  }

  /**
   * `sysio.synd::sweep` — deliver the shadow parked against an account's link
   * for a chain family. Permissionless: `signer` only foots the CPU.
   */
  export function planSweep<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSyndSweepAction,
    signer: string
  ): ClusterBuildStep<C, SweepInput> {
    return ClusterBuildStep.create<C, SweepInput>(
      actor,
      name,
      description,
      options,
      { kind: "SyndContractSteps.SweepInput", data, signer },
      runSweep
    )
  }

  /** Named runner — `sysio.synd::sweep`, signed by the CPU payer. */
  export async function runSweep<C extends ClusterBuildContext>(
    ctx: C,
    input: SweepInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .actions.sweep.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.signer)
      })
  }

  /** Input for {@link planImportsynd} — the generated `sysio.synd::importsynd` data. */
  export interface ImportsyndInput extends StepInput {
    readonly kind: "SyndContractSteps.ImportsyndInput"
    readonly data: SysioContracts.SysioSyndImportsyndAction
  }

  /**
   * `sysio.synd::importsynd` — credit pre-launch syndicated positions, by
   * pubkey, in the bootstrap window only. Signed by the contract.
   */
  export function planImportsynd<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSyndImportsyndAction
  ): ClusterBuildStep<C, ImportsyndInput> {
    return ClusterBuildStep.create<C, ImportsyndInput>(
      actor,
      name,
      description,
      options,
      { kind: "SyndContractSteps.ImportsyndInput", data },
      runImportsynd
    )
  }

  /** Named runner — `sysio.synd::importsynd`, signed by the contract. */
  export async function runImportsynd<C extends ClusterBuildContext>(
    ctx: C,
    input: ImportsyndInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .actions.importsynd.invoke(input.data)
  }

  /** Input for {@link planImportdone} — the generated `sysio.synd::importdone` data. */
  export interface ImportdoneInput extends StepInput {
    readonly kind: "SyndContractSteps.ImportdoneInput"
    readonly data: SysioContracts.SysioSyndImportdoneAction
  }

  /**
   * `sysio.synd::importdone` — close the launch import for good. Signed by the
   * contract.
   */
  export function planImportdone<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSyndImportdoneAction
  ): ClusterBuildStep<C, ImportdoneInput> {
    return ClusterBuildStep.create<C, ImportdoneInput>(
      actor,
      name,
      description,
      options,
      { kind: "SyndContractSteps.ImportdoneInput", data },
      runImportdone
    )
  }

  /** Named runner — `sysio.synd::importdone`, signed by the contract. */
  export async function runImportdone<C extends ClusterBuildContext>(
    ctx: C,
    input: ImportdoneInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .actions.importdone.invoke(input.data)
  }

  /** Input for {@link planSweepyield} — the generated `sysio.synd::sweepyield` data plus the CPU payer. */
  export interface SweepyieldInput extends StepInput {
    readonly kind: "SyndContractSteps.SweepyieldInput"
    readonly data: SysioContracts.SysioSyndSweepyieldAction
    /** The account whose signature carries the permissionless push. */
    readonly signer: string
  }

  /**
   * `sysio.synd::sweepyield` — pull the WIRE the contract's holder row earned
   * into the token's yield pool, and pay the fee pot's share to `sysio`.
   * Permissionless: `signer` only foots the CPU.
   */
  export function planSweepyield<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioSyndSweepyieldAction,
    signer: string
  ): ClusterBuildStep<C, SweepyieldInput> {
    return ClusterBuildStep.create<C, SweepyieldInput>(
      actor,
      name,
      description,
      options,
      { kind: "SyndContractSteps.SweepyieldInput", data, signer },
      runSweepyield
    )
  }

  /** Named runner — `sysio.synd::sweepyield`, signed by the CPU payer. */
  export async function runSweepyield<C extends ClusterBuildContext>(
    ctx: C,
    input: SweepyieldInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.synd)
      .actions.sweepyield.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.signer)
      })
  }
}
