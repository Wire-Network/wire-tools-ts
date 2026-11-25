import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"

import { WireClient } from "../../../../clients/wire/WireClient.js"
import type { Constants } from "../../../../Constants.js"
import { isCode } from "../../../../utils/slugUtils.js"
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
  export function planSetconfig<C extends ClusterBuildContext = ClusterBuildContext>(
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
  export function planRegoperator<C extends ClusterBuildContext = ClusterBuildContext>(
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

  /** Input for {@link planJoinchain} — the generated `opreg::joinchain` data. */
  export interface JoinchainInput extends StepInput {
    readonly kind: "OpregContractSteps.JoinchainInput"
    /** The action data: the joining operator's account and the outpost chain it joins. */
    readonly data: SysioContracts.SysioOpregJoinchainAction
  }

  /**
   * `sysio.opreg::joinchain` — the batch operator starts SERVING one outpost chain, so that
   * chain's schedule draws new seats from it. Requires the operator's `sysio.authex` link for
   * the chain's kind; a LEFT or EVICTED operator rejoins only once it holds no seat in the
   * chain's window nor in its `previous_group`, the group whose books the chain's next advance
   * closes. Signed by the operator itself — the self-service path.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The operator's account and the outpost chain it joins.
   * @returns The `sysio.opreg` step.
   */
  export function planJoinchain<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregJoinchainAction
  ): ClusterBuildStep<C, JoinchainInput> {
    return ClusterBuildStep.create<C, JoinchainInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.JoinchainInput", data },
      runJoinchain
    )
  }

  /** Named runner — `sysio.opreg::joinchain`, signed by the joining operator. */
  export async function runJoinchain<C extends ClusterBuildContext>(
    ctx: C,
    input: JoinchainInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.joinchain.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.account)
      })
  }

  /** Input for {@link planLeavechain} — the generated `opreg::leavechain` data. */
  export interface LeavechainInput extends StepInput {
    readonly kind: "OpregContractSteps.LeavechainInput"
    /** The action data: the leaving operator's account and the outpost chain it leaves. */
    readonly data: SysioContracts.SysioOpregLeavechainAction
  }

  /**
   * `sysio.opreg::leavechain` — the batch operator stops serving one outpost chain (SERVING
   * becomes LEFT): the chain draws no new seat from it, and it still owes every seat it holds
   * there. Signed by the operator.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The operator's account and the outpost chain it leaves.
   * @returns The `sysio.opreg` step.
   */
  export function planLeavechain<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregLeavechainAction
  ): ClusterBuildStep<C, LeavechainInput> {
    return ClusterBuildStep.create<C, LeavechainInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.LeavechainInput", data },
      runLeavechain
    )
  }

  /** Named runner — `sysio.opreg::leavechain`, signed by the leaving operator. */
  export async function runLeavechain<C extends ClusterBuildContext>(
    ctx: C,
    input: LeavechainInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.leavechain.invoke(input.data, {
        authorization: WireClient.activeAuthorization(input.data.account)
      })
  }

  /** Input for {@link planTerminate} — the generated `opreg::terminate` data. */
  export interface TerminateInput extends StepInput {
    readonly kind: "OpregContractSteps.TerminateInput"
    /** The action data: the operator governance terminates. */
    readonly data: SysioContracts.SysioOpregTerminateAction
  }

  /**
   * `sysio.opreg::terminate` — governance terminates the operator globally: status TERMINATED,
   * and its collateral credited to `remitclaims` for `claimremit`. The miss rails never do this;
   * they evict the operator from one chain. Signed `sysio.opreg@active`.
   *
   * @param actor - The narrative subject.
   * @param name - Step name (report row).
   * @param description - One-line description.
   * @param options - Step option overrides.
   * @param data - The operator to terminate.
   * @returns The `sysio.opreg` step.
   */
  export function planTerminate<C extends ClusterBuildContext = ClusterBuildContext>(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    data: SysioContracts.SysioOpregTerminateAction
  ): ClusterBuildStep<C, TerminateInput> {
    return ClusterBuildStep.create<C, TerminateInput>(
      actor,
      name,
      description,
      options,
      { kind: "OpregContractSteps.TerminateInput", data },
      runTerminate
    )
  }

  /** Named runner — `sysio.opreg::terminate`, signed by the contract account. */
  export async function runTerminate<C extends ClusterBuildContext>(
    ctx: C,
    input: TerminateInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .actions.terminate.invoke(input.data)
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
  export function planDeposit<C extends ClusterBuildContext = ClusterBuildContext>(
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
  export function planWithdraw<C extends ClusterBuildContext = ClusterBuildContext>(
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
  export function planClaimremit<C extends ClusterBuildContext = ClusterBuildContext>(
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

  /**
   * Row limit of {@link readServedChains}: one row per (operator, outpost chain). A read that
   * comes back with `more` set is refused rather than trusted, so a membership past the limit
   * can never read as absent.
   */
  export const ServedChainReadLimit = 200

  /**
   * Every `sysio.opreg::servchains` row, from ONE complete read through the typed table
   * accessor — every batch operator's membership of every outpost chain it joined.
   *
   * @param ctx - The build context.
   * @returns Every membership row, chain first then account.
   * @throws When the table holds more than {@link ServedChainReadLimit} rows.
   */
  export async function readServedChains<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioOpregServedChainType[]> {
    const { rows, more } = await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .tables.servchains.query({ limit: ServedChainReadLimit })
    Assert.ok(
      !more,
      `OpregContractSteps: sysio.opreg::servchains has more than ${ServedChainReadLimit} rows; the read is truncated`
    )
    return rows
  }

  /**
   * One batch operator's membership row on one outpost chain.
   *
   * @param ctx - The build context.
   * @param account - The operator's on-chain account.
   * @param chain - The outpost chain.
   * @returns The membership row (absent when the operator never joined the chain).
   */
  export async function readMembership<C extends ClusterBuildContext>(
    ctx: C,
    account: string,
    chain: Constants.OutpostChainCodename
  ): Promise<SysioContracts.SysioOpregServedChainType> {
    return (await readServedChains(ctx)).find(row => isMembershipRow(row, account, chain))
  }

  /**
   * Whether a `sysio.opreg::servchains` row is `account`'s membership of `chain` — pure.
   *
   * @param row - One membership row.
   * @param account - The operator's on-chain account.
   * @param chain - The outpost chain.
   * @returns True when the row is the operator's membership of the chain.
   * @throws If the row's `chain_code` is not a slug carrier.
   */
  export function isMembershipRow(
    row: SysioContracts.SysioOpregServedChainType,
    account: string,
    chain: Constants.OutpostChainCodename
  ): boolean {
    return row.account === account && isCode(row.chain_code, chain)
  }
}
