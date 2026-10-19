import Assert from "node:assert"
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

/** Steps for `sysio.opreg` (operator registry) actions. */
export namespace OpregContractSteps {
  /** Input for {@link planSetconfig} — the generated `opreg::setconfig` data. */
  export interface SetconfigInput extends StepInput {
    readonly kind: "OpregContractSteps.SetconfigInput"
    readonly data: SysioContracts.SysioOpregSetconfigAction
  }

  /** `sysio.opreg::setconfig` — availability caps, termination thresholds, collateral minimums. */
  export function planSetconfig<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregSetconfigAction
  ): ClusterBuildStep<C, SetconfigInput> {
    return ClusterBuildStep.create<C, SetconfigInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.SetconfigInput", data },
      runSetconfig
    )
  }

  /** Named runner — `sysio.opreg::setconfig`. */
  export async function runSetconfig<C extends ClusterBuildContext>(
    ctx: C,
    input: SetconfigInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.setconfig.invoke(input.data)
  }

  /** Input for {@link planRegoperator} — the generated `opreg::regoperator` data. */
  export interface RegoperatorInput extends StepInput {
    readonly kind: "OpregContractSteps.RegoperatorInput"
    readonly data: SysioContracts.SysioOpregRegoperatorAction
  }

  /** `sysio.opreg::regoperator` — register a batch operator / underwriter / producer. */
  export function planRegoperator<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregRegoperatorAction
  ): ClusterBuildStep<C, RegoperatorInput> {
    return ClusterBuildStep.create<C, RegoperatorInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.RegoperatorInput", data },
      runRegoperator
    )
  }

  /** Named runner — `sysio.opreg::regoperator`. */
  export async function runRegoperator<C extends ClusterBuildContext>(
    ctx: C,
    input: RegoperatorInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.regoperator.invoke(input.data)
  }

  /** Input for {@link planTerminate} — a harness operator label and generated action data. */
  export interface TerminateInput extends StepInput {
    readonly kind: "OpregContractSteps.TerminateInput"
    /** Harness label resolved to the generated WIRE account during execution. */
    readonly label: string
    /** Generated action data except the account resolved from {@link label}. */
    readonly data: Omit<SysioContracts.SysioOpregTerminateAction, "account">
  }

  /**
   * Plan `sysio.opreg::terminate` to administratively remove an operator from eligibility.
   *
   * @param actor - The narrative subject.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step option overrides.
   * @param label - Harness operator label resolved at execution time.
   * @param data - Generated action data except the resolved operator account.
   * @returns The definition step.
   */
  export function planTerminate<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    data: Omit<SysioContracts.SysioOpregTerminateAction, "account">
  ): ClusterBuildStep<C, TerminateInput> {
    return ClusterBuildStep.create<C, TerminateInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.TerminateInput", label, data },
      runTerminate
    )
  }

  /**
   * Resolve the harness operator label and invoke `sysio.opreg::terminate`.
   *
   * @param ctx - The build context.
   * @param input - Operator label and generated action data from the definition step.
   * @param signal - Abort signal checked before resolving or invoking.
   * @returns A promise that resolves after the action reaches finality.
   */
  export async function runTerminate<C extends ClusterBuildContext>(
    ctx: C,
    input: TerminateInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.terminate.invoke({
        ...input.data,
        account: ctx.keyStore.assertOperator(input.label).account
      })
  }

  /** Input for {@link planProcessbatch} — a harness label plus generated action data. */
  export interface ProcessbatchInput extends StepInput {
    readonly kind: "OpregContractSteps.ProcessbatchInput"
    /** Harness label resolved to the generated WIRE account during execution. */
    readonly label: string
    /** Generated action data except the account resolved from {@link label}. */
    readonly data: Omit<SysioContracts.SysioOpregProcessbatchAction, "account">
  }

  /** Plan `sysio.opreg::processbatch` for an operator resolved by harness label. */
  export function planProcessbatch<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    data: Omit<SysioContracts.SysioOpregProcessbatchAction, "account">
  ): ClusterBuildStep<C, ProcessbatchInput> {
    return ClusterBuildStep.create<C, ProcessbatchInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.ProcessbatchInput", label, data },
      runProcessbatch
    )
  }

  /** Resolve the harness operator label and invoke `sysio.opreg::processbatch`. */
  export async function runProcessbatch<C extends ClusterBuildContext>(
    ctx: C,
    input: ProcessbatchInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.processbatch.invoke({
        ...input.data,
        account: ctx.keyStore.assertOperator(input.label).account
      })
  }

  /** Input for {@link planDeposit} — the generated `opreg::deposit` data. */
  export interface DepositInput extends StepInput {
    readonly kind: "OpregContractSteps.DepositInput"
    readonly data: SysioContracts.SysioOpregDepositAction
  }

  /**
   * `sysio.opreg::deposit` — bond depot-native collateral (WIRE or a shadow LIQ symbol)
   * into the `(WIRE, token_code)` balance row. The contract moves the tokens out of
   * `data.account` under that account's own authority, so the operator signs and must
   * already hold `amount` of the token.
   */
  export function planDeposit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregDepositAction
  ): ClusterBuildStep<C, DepositInput> {
    return ClusterBuildStep.create<C, DepositInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.DepositInput", data },
      runDeposit
    )
  }

  /** Named runner — `sysio.opreg::deposit`, signed by the depositing operator. */
  export async function runDeposit<C extends ClusterBuildContext>(
    ctx: C,
    input: DepositInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.deposit.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.account)
      })
  }

  /** Input for {@link planWithdraw} — the generated `opreg::withdraw` data. */
  export interface WithdrawInput extends StepInput {
    readonly kind: "OpregContractSteps.WithdrawInput"
    readonly data: SysioContracts.SysioOpregWithdrawAction
  }

  /**
   * `sysio.opreg::withdraw` — queue a withdrawal from the `(WIRE, token_code)` row. It
   * matures after the contract's withdraw wait and is flushed at an epoch boundary into a
   * `remitclaims` row; nothing is paid until {@link planClaimremit}.
   *
   * The action does NOT revert when it refuses a request: an unregistered operator, a
   * status that cannot withdraw, too little available balance, or an outstanding request in
   * the same bucket each commit the transaction and only append a failed entry to the
   * operator's `recent_actions`. Only an unsupported token reverts. This Step therefore
   * succeeds on a refused request; `WireCollateralTool.planWithdrawal` confirms the queue row.
   */
  export function planWithdraw<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregWithdrawAction
  ): ClusterBuildStep<C, WithdrawInput> {
    return ClusterBuildStep.create<C, WithdrawInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.WithdrawInput", data },
      runWithdraw
    )
  }

  /** Named runner — `sysio.opreg::withdraw`, signed by the withdrawing operator. */
  export async function runWithdraw<C extends ClusterBuildContext>(
    ctx: C,
    input: WithdrawInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.withdraw.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.account)
      })
  }

  /** Input for {@link planClaimremit} — the generated `opreg::claimremit` data. */
  export interface ClaimremitInput extends StepInput {
    readonly kind: "OpregContractSteps.ClaimremitInput"
    readonly data: SysioContracts.SysioOpregClaimremitAction
  }

  /**
   * `sysio.opreg::claimremit` — pay the `remitclaims{account, token_code}` row out of the
   * token's custody contract in one transfer.
   */
  export function planClaimremit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregClaimremitAction
  ): ClusterBuildStep<C, ClaimremitInput> {
    return ClusterBuildStep.create<C, ClaimremitInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.ClaimremitInput", data },
      runClaimremit
    )
  }

  /** Named runner — `sysio.opreg::claimremit`, signed by the claiming operator. */
  export async function runClaimremit<C extends ClusterBuildContext>(
    ctx: C,
    input: ClaimremitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.claimremit.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.account)
      })
  }

  // ── Reads (execute freely inside runners / verify steps) ─────────────────

  /**
   * Row limit of {@link readOperators}. A read that comes back with `more` set is
   * refused rather than trusted, so an operator past the limit can never read as
   * absent; raising it only widens that one read.
   */
  export const OperatorTableReadLimit = 100

  /**
   * Every `sysio.opreg::operators` row, from ONE complete read through the typed
   * table accessor.
   *
   * @param ctx - The build context.
   * @returns Every operator row, in table order.
   * @throws When the table holds more than {@link OperatorTableReadLimit} rows.
   */
  export async function readOperators<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioOpregOperatorEntryType[]> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .tables.operators.query({ limit: OperatorTableReadLimit })
    Assert.ok(
      !more,
      `OpregContractSteps: sysio.opreg::operators has more than ${OperatorTableReadLimit} rows; the read is truncated`
    )
    return rows
  }
}
