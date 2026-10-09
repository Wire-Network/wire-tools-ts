import { Constants } from "../../Constants.js"
/**
 * WireCollateralTool — Step factories for depot-native operator collateral on
 * `sysio.opreg`. Every on-chain WRITE is its OWN {@link ClusterBuildStep} so the
 * `Report` records it: {@link WireCollateralTool.planFunding} (the WIRE the operator
 * must hold before it can bond), the `opreg::deposit` bond composed with it by
 * {@link WireCollateralTool.planDeposit}, {@link WireCollateralTool.planWithdrawal}
 * (the queued withdrawal) and {@link WireCollateralTool.planClaimremit} (the payout).
 * Each runner resolves the operator's on-chain account from `ctx.keyStore` by its
 * durable `label` at RUN time — the account may be adopted by a step that has not run
 * when these are constructed — and delegates the write to the matching
 * `Steps.contracts.sysio` runner, so each action has one invoke body.
 *
 * {@link WireCollateralTool.planVerifyBalanceRow} and
 * {@link WireCollateralTool.planVerifyRemitClaim} are the verify Steps; their reads go
 * through the typed `operators` / `remitclaims` table accessors.
 * {@link WireCollateralTool.planRecordWireBalance} and
 * {@link WireCollateralTool.planVerifyWireBalanceIncrease} bracket a payout: the first
 * records the operator's liquid WIRE, the second asserts what the payout added.
 */

import Assert from "node:assert"

import type {
  ChainTokenAmount,
  CollateralRequirement
} from "@wireio/cluster-tool-shared"
import { TokenAmount } from "@wireio/opp-typescript-models"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"

import { ProtocolTiming } from "../../Constants.js"
import { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import { outputKey, type OutputKey } from "../../orchestration/OutputStore.js"
import type { StepInput } from "../../orchestration/StepRunner.js"
import { pollUntil } from "../../orchestration/StepTools.js"
import { OpregContractSteps } from "../../orchestration/steps/contracts/sysio/OpregContractSteps.js"
import { TokenContractSteps } from "../../orchestration/steps/contracts/sysio/TokenContractSteps.js"
import { Report } from "../../report/Report.js"
import { slugValue } from "../../utils/slugUtils.js"
import { formatWireAsset } from "./WireUserTool.js"

const log = getLogger(__filename)

const { SysioContractName } = SysioContracts

/** Depot-native collateral on `sysio.opreg` — fund, bond, withdraw, claim, and verify Steps. */
export namespace WireCollateralTool {
  /**
   * The account whose WIRE funds an operator's bond. `sysio` holds the bootstrap WIRE
   * issue; `sysio.token::transfer` from it is the harness's one WIRE funding path.
   *
   * Coupled to `TokenContractSteps.runTransfer`, which always signs as `sysio@active`
   * through a module-private authorization: the transfer's `from` must be the account
   * that signs it, so changing this value without changing that signer makes every
   * funding Step fail its authorization check.
   */
  export const FundingAccount = "sysio"

  /** Memo on the funding transfer — names the purpose in the account's history. */
  export const FundingMemo = "harness depot collateral funding"

  /**
   * Row limit for the `operators` / `remitclaims` / `wtdwqueue` reads. A read that comes
   * back with `more` set is refused ({@link assertCompleteRead}) rather than trusted, so a
   * row past the limit can never read as absent.
   */
  export const TableRowLimit = 100

  /**
   * Epochs a remit claim may take to appear: the contract's two-epoch withdraw wait, the
   * boundary whose `flushwtdw` credits the claim, and one epoch of margin. Changing it
   * moves the {@link planVerifyRemitClaim} deadline.
   */
  export const RemitClaimEpochCount = 4

  /** Gap between {@link planVerifyRemitClaim} reads (ms). */
  export const RemitClaimPollIntervalMs = 1_000

  /** Suffix of the funding Step's name in {@link planDeposit}. */
  export const FundingStepSuffix = "-fund"

  /**
   * The WIRE token's packed slug code as the `bigint` a `TokenAmount` carries — the token
   * every WIRE bond, claim and payout here is keyed on.
   */
  export const WireTokenCode = BigInt(Constants.WireTokenCode)

  // ── Step: WIRE funding (`sysio.token::transfer`) ─────────────────────────

  /** Input for {@link planFunding} — one WIRE transfer to the operator's account. */
  export interface FundingInput extends StepInput {
    readonly kind: "WireCollateralTool.FundingInput"
    /** Operator's durable `label` handle — resolved from `ctx.keyStore` (NOT its on-chain `account`). */
    readonly operatorLabel: string
    /** The WIRE to transfer — `(WIRE, WIRE)` in depot atomic units (9 decimals). */
    readonly collateral: ChainTokenAmount
  }

  /**
   * A single `sysio.token::transfer` of WIRE from {@link FundingAccount} to the
   * operator, so it holds the tokens `opreg::deposit` moves under its own authority.
   *
   * @throws If `collateral` is not a WIRE amount on the WIRE chain.
   */
  export function planFunding<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    collateral: ChainTokenAmount
  ): ClusterBuildStep<C, FundingInput> {
    assertWireCollateral(collateral)
    return ClusterBuildStep.create<C, FundingInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireCollateralTool.FundingInput", operatorLabel, collateral },
      runFunding
    )
  }

  /** Named runner — resolve the account, then delegate ONE transfer to `TokenContractSteps.runTransfer`. */
  export async function runFunding<C extends ClusterBuildContext>(
    ctx: C,
    input: FundingInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertPositive(input.collateral.amount)
    const operator = ctx.keyStore.assertOperator(input.operatorLabel)
    await TokenContractSteps.runTransfer(
      ctx,
      {
        kind: "TokenContractSteps.TransferInput",
        data: {
          from: FundingAccount,
          to: operator.account,
          quantity: formatWireAsset(input.collateral.amount.amount),
          memo: FundingMemo
        }
      },
      signal
    )
  }

  // ── Steps: fund + bond (`sysio.opreg::deposit`) ──────────────────────────

  /** Input for the bond Step {@link planDeposit} composes — one `opreg::deposit`. */
  export interface DepositInput extends StepInput {
    readonly kind: "WireCollateralTool.DepositInput"
    /** Operator's durable `label` handle — resolved from `ctx.keyStore` (NOT its on-chain `account`). */
    readonly operatorLabel: string
    /** The bond — `(WIRE, token)` in depot atomic units. */
    readonly collateral: ChainTokenAmount
  }

  /**
   * Fund the operator with WIRE, then bond it: {@link planFunding} followed by one
   * `opreg::deposit` Step ({@link runDeposit}). Two writes, two Steps, in order — the
   * caller pushes them into its Phase.
   *
   * @param actor - The Report actor (the depositing operator's role).
   * @param name - Name stem; the Steps are `<name>-fund` and `<name>`.
   * @param description - Description of the bond Step.
   * @param options - Step option overrides for both Steps.
   * @param operatorLabel - The operator's `ClusterKeyStore` handle.
   * @param collateral - `(WIRE, WIRE)` amount in depot atomic units.
   * @returns The funding Step and the bond Step.
   * @throws If `collateral` is not a WIRE amount on the WIRE chain — only WIRE has a
   *   harness funding path.
   */
  export function planDeposit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    collateral: ChainTokenAmount
  ): ClusterBuildStep.Any<C>[] {
    return [
      planFunding<C>(
        actor,
        `${name}${FundingStepSuffix}`,
        `fund ${operatorLabel} with ${formatWireAsset(collateral.amount.amount)} to bond`,
        options,
        operatorLabel,
        collateral
      ),
      ClusterBuildStep.create<C, DepositInput>(
        actor,
        name,
        description,
        options,
        { kind: "WireCollateralTool.DepositInput", operatorLabel, collateral },
        runDeposit
      )
    ]
  }

  /** Named runner — resolve the account, then delegate ONE bond to `OpregContractSteps.runDeposit`. */
  export async function runDeposit<C extends ClusterBuildContext>(
    ctx: C,
    input: DepositInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertDepotCollateral(input.collateral)
    assertPositive(input.collateral.amount)
    const operator = ctx.keyStore.assertOperator(input.operatorLabel)
    await OpregContractSteps.runDeposit(
      ctx,
      {
        kind: "OpregContractSteps.DepositInput",
        data: {
          account: operator.account,
          token_code: tokenSpelling(input.collateral.amount.tokenCode),
          amount: input.collateral.amount.amount.toString()
        }
      },
      signal
    )
  }

  // ── Step: withdrawal request (`sysio.opreg::withdraw`) ───────────────────

  /** Input for {@link planWithdrawal} — one `opreg::withdraw`. */
  export interface WithdrawInput extends StepInput {
    readonly kind: "WireCollateralTool.WithdrawInput"
    /** Operator's durable `label` handle — resolved from `ctx.keyStore` (NOT its on-chain `account`). */
    readonly operatorLabel: string
    /** The amount to withdraw from the `(WIRE, token)` row, in depot atomic units. */
    readonly collateral: ChainTokenAmount
  }

  /**
   * A single `opreg::withdraw`. This QUEUES the withdrawal: after the wait it is flushed
   * into a `remitclaims` row ({@link planVerifyRemitClaim}) and paid by
   * {@link planClaimremit}.
   *
   * `opreg::withdraw` commits even when it refuses the request, so the runner confirms a
   * NEW `wtdwqueue` row for the account, the WIRE chain, the token and the amount, and fails
   * the Step otherwise, carrying the reason from the operator's `recent_actions` when the
   * contract logged one.
   *
   * @throws If `collateral` is not on the WIRE chain.
   */
  export function planWithdrawal<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    collateral: ChainTokenAmount
  ): ClusterBuildStep<C, WithdrawInput> {
    assertDepotCollateral(collateral)
    return ClusterBuildStep.create<C, WithdrawInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireCollateralTool.WithdrawInput", operatorLabel, collateral },
      runWithdrawal
    )
  }

  /** Named runner — resolve the account, then delegate ONE withdraw to `OpregContractSteps.runWithdraw`. */
  export async function runWithdrawal<C extends ClusterBuildContext>(
    ctx: C,
    input: WithdrawInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertPositive(input.collateral.amount)
    const operator = ctx.keyStore.assertOperator(input.operatorLabel),
      { tokenCode, amount } = input.collateral.amount,
      priorRequestIds = new Set(
        (await readWithdrawRequests(ctx, operator.account)).map(row =>
          BigInt(row.request_id)
        )
      )
    await OpregContractSteps.runWithdraw(
      ctx,
      {
        kind: "OpregContractSteps.WithdrawInput",
        data: {
          account: operator.account,
          token_code: tokenSpelling(tokenCode),
          amount: amount.toString()
        }
      },
      signal
    )
    // `withdraw` commits even when it refuses the request, so the push succeeding proves
    // nothing: the queue row is the evidence the request was accepted.
    const queued = (await readWithdrawRequests(ctx, operator.account)).some(
      row =>
        !priorRequestIds.has(BigInt(row.request_id)) &&
        slugValue(row.chain_code) === Constants.WireChainCode &&
        BigInt(slugValue(row.token_code)) === tokenCode &&
        BigInt(row.amount) === amount
    )
    if (!queued) {
      const reason = await readRefusalReason(ctx, operator.account)
      throw new Error(
        `WireCollateralTool: sysio.opreg refused ${operator.account}'s withdrawal of ${amount} ` +
          `${tokenSpelling(tokenCode)} — no new wtdwqueue row; ${reason}`
      )
    }
  }

  /**
   * READ the account's queued withdrawals from `sysio.opreg::wtdwqueue` (every bucket).
   */
  export async function readWithdrawRequests<C extends ClusterBuildContext>(
    ctx: C,
    account: string
  ): Promise<SysioContracts.SysioOpregWithdrawRequestType[]> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .tables.wtdwqueue.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, WithdrawQueueTable)
    return result.rows.filter(row => row.account === account)
  }

  /**
   * READ why the contract refused the operator's latest action: the `error_message` of the
   * newest `recent_actions` entry when that entry failed, otherwise a statement that the
   * contract refused without a readable reason. A failed read is logged and answers with
   * that statement too, so the refusal the caller is reporting is never replaced by the
   * read's own error.
   */
  export async function readRefusalReason<C extends ClusterBuildContext>(
    ctx: C,
    account: string
  ): Promise<string> {
    try {
      const latest = (await findOperatorRow(ctx, account))?.recent_actions.at(
        -1
      )
      return latest != null && !latest.success
        ? `contract reason: ${latest.error_message}`
        : UnreadableRefusalReason
    } catch (error) {
      log.warn(
        `WireCollateralTool: reading ${account}'s refusal reason failed: ` +
          `${error instanceof Error ? error.message : String(error)}`
      )
      return UnreadableRefusalReason
    }
  }

  /** {@link readRefusalReason}'s answer when the operator's action log carries no failure. */
  export const UnreadableRefusalReason =
    "the contract refused the request and its action log carries no failure reason"

  // ── Step: payout (`sysio.opreg::claimremit`) ─────────────────────────────

  /** Input for {@link planClaimremit} — one `opreg::claimremit`. */
  export interface ClaimremitInput extends StepInput {
    readonly kind: "WireCollateralTool.ClaimremitInput"
    /** Operator's durable `label` handle — resolved from `ctx.keyStore` (NOT its on-chain `account`). */
    readonly operatorLabel: string
    /** slug_name (`uint64`) of the claimed token. */
    readonly tokenCode: bigint
  }

  /** A single `opreg::claimremit` of the operator's `remitclaims{account, token}` row. */
  export function planClaimremit<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    tokenCode: bigint
  ): ClusterBuildStep<C, ClaimremitInput> {
    return ClusterBuildStep.create<C, ClaimremitInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireCollateralTool.ClaimremitInput", operatorLabel, tokenCode },
      runClaimremit
    )
  }

  /** Named runner — resolve the account, then delegate ONE claim to `OpregContractSteps.runClaimremit`. */
  export async function runClaimremit<C extends ClusterBuildContext>(
    ctx: C,
    input: ClaimremitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const operator = ctx.keyStore.assertOperator(input.operatorLabel)
    await OpregContractSteps.runClaimremit(
      ctx,
      {
        kind: "OpregContractSteps.ClaimremitInput",
        data: {
          account: operator.account,
          token_code: tokenSpelling(input.tokenCode)
        }
      },
      signal
    )
  }

  // ── Verify: the WIRE a `claimremit` pays out ─────────────────────────────

  /** Name prefix of every {@link wireBalanceKey}; the operator's `label` follows it. */
  export const WireBalanceKeyPrefix = "WireCollateralTool.wireBalance."

  /**
   * The {@link ClusterBuildContext.outputs} key {@link planRecordWireBalance} stores an
   * operator's liquid WIRE balance under, one key per operator `label`, so two operators'
   * records never collide. {@link planVerifyWireBalanceIncrease} reads it back.
   */
  export function wireBalanceKey(operatorLabel: string): OutputKey<bigint> {
    return outputKey<bigint>(
      `${WireBalanceKeyPrefix}${operatorLabel}`,
      `${operatorLabel}'s liquid WIRE balance (depot atomic units) recorded before a payout`
    )
  }

  /** Input for {@link planRecordWireBalance}. */
  export interface RecordWireBalanceInput extends StepInput {
    readonly kind: "WireCollateralTool.RecordWireBalanceInput"
    /** Operator's durable `label` handle — resolved from `ctx.keyStore` (NOT its on-chain `account`). */
    readonly operatorLabel: string
  }

  /**
   * Record the operator's liquid WIRE balance (`sysio.token`) under
   * {@link wireBalanceKey}, so a later {@link planVerifyWireBalanceIncrease} can assert what a
   * payout added. A read, carried by a Step because its value crosses to another Step.
   * Place it immediately before the write it measures, with no other transfer to the
   * operator in between.
   */
  export function planRecordWireBalance<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string
  ): ClusterBuildStep<C, RecordWireBalanceInput> {
    return ClusterBuildStep.create<C, RecordWireBalanceInput>(
      actor,
      name,
      description,
      options,
      { kind: "WireCollateralTool.RecordWireBalanceInput", operatorLabel },
      runRecordWireBalance
    )
  }

  /** Named runner — read the operator's liquid WIRE and store it under {@link wireBalanceKey}. */
  export async function runRecordWireBalance<C extends ClusterBuildContext>(
    ctx: C,
    input: RecordWireBalanceInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const account = ctx.keyStore.assertOperator(input.operatorLabel).account
    ctx.outputs.set(
      wireBalanceKey(input.operatorLabel),
      await ctx.wire.getWireBalance(account)
    )
  }

  /** Input for {@link planVerifyWireBalanceIncrease}. */
  export interface VerifyWireBalanceIncreaseInput extends StepInput {
    readonly kind: "WireCollateralTool.VerifyWireBalanceIncreaseInput"
    /** Operator's durable `label` handle — resolved from `ctx.keyStore` (NOT its on-chain `account`). */
    readonly operatorLabel: string
    /** The exact WIRE the payout must have added, in depot atomic units. */
    readonly increase: bigint
  }

  /**
   * Assert the operator's liquid WIRE balance rose by exactly `increase` since
   * {@link planRecordWireBalance} recorded it — the `claimremit` transfer arrived, in full
   * and no more. One read: the payout is confirmed irreversible before this Step runs.
   */
  export function planVerifyWireBalanceIncrease<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    increase: bigint
  ): ClusterBuildStep<C, VerifyWireBalanceIncreaseInput> {
    return ClusterBuildStep.create<C, VerifyWireBalanceIncreaseInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireCollateralTool.VerifyWireBalanceIncreaseInput",
        operatorLabel,
        increase
      },
      runVerifyWireBalanceIncrease
    )
  }

  /** Named runner — compare the operator's liquid WIRE with the recorded balance. */
  export async function runVerifyWireBalanceIncrease<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: VerifyWireBalanceIncreaseInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const recorded = ctx.outputs.assert(wireBalanceKey(input.operatorLabel)),
      account = ctx.keyStore.assertOperator(input.operatorLabel).account,
      increase = (await ctx.wire.getWireBalance(account)) - recorded
    Assert.ok(
      increase === input.increase,
      `WireCollateralTool: ${account}'s liquid WIRE rose by ${increase}, expected ${input.increase}`
    )
  }

  // ── Verify: the `(WIRE, token)` balance row ──────────────────────────────

  /** Input for {@link planVerifyBalanceRow}. */
  export interface VerifyBalanceRowInput extends StepInput {
    readonly kind: "WireCollateralTool.VerifyBalanceRowInput"
    /** Operator's durable `label` handle — resolved from `ctx.keyStore` (NOT its on-chain `account`). */
    readonly operatorLabel: string
    /** The expected row: `(WIRE, token)` and its exact balance in depot atomic units. */
    readonly collateral: ChainTokenAmount
  }

  /**
   * Assert the operator's `(WIRE, token)` balance row on `sysio.opreg::operators` holds
   * exactly `collateral.amount` — an exact match, not a minimum. The caller passes the
   * cumulative balance it expects the row to hold (every deposit, less every flushed
   * withdrawal and slash), not the amount of the last write. A missing row reads as a zero
   * balance, so a zero expectation also verifies a drained row. One read: the writes it follows are
   * confirmed irreversible before this Step runs.
   *
   * @throws If `collateral` is not on the WIRE chain.
   */
  export function planVerifyBalanceRow<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    collateral: ChainTokenAmount
  ): ClusterBuildStep<C, VerifyBalanceRowInput> {
    assertDepotCollateral(collateral)
    return ClusterBuildStep.create<C, VerifyBalanceRowInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireCollateralTool.VerifyBalanceRowInput",
        operatorLabel,
        collateral
      },
      runVerifyBalanceRow
    )
  }

  /** Named runner — read the operator's row and assert the `(WIRE, token)` balance. */
  export async function runVerifyBalanceRow<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyBalanceRowInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const account = ctx.keyStore.assertOperator(input.operatorLabel).account,
      { tokenCode, amount } = input.collateral.amount,
      balance = await readBalance(ctx, account, tokenCode)
    Assert.ok(
      balance === amount,
      `WireCollateralTool: ${account} (WIRE, ${tokenSpelling(tokenCode)}) balance is ${balance}, expected ${amount}`
    )
  }

  /**
   * READ an operator's `(WIRE, token)` balance from `sysio.opreg::operators` — `0n` when
   * the operator or the row is absent.
   */
  export async function readBalance<C extends ClusterBuildContext>(
    ctx: C,
    account: string,
    tokenCode: bigint
  ): Promise<bigint> {
    const entry = (await findOperatorRow(ctx, account))?.balances.find(
      balance =>
        slugValue(balance.chain_code) === Constants.WireChainCode &&
        BigInt(slugValue(balance.token_code)) === tokenCode
    )
    return entry == null ? 0n : BigInt(entry.balance)
  }

  /**
   * READ the operator's row on `sysio.opreg::operators`, by its durable `label` — the row a
   * scenario asserts status, bootstrap flag and audit trail on. Absent when `regoperator` has
   * not run for the account.
   *
   * @throws If the operator is not in the key store, or the read is truncated.
   */
  export async function readOperatorRow<C extends ClusterBuildContext>(
    ctx: C,
    operatorLabel: string
  ): Promise<SysioContracts.SysioOpregOperatorEntryType> {
    return findOperatorRow(
      ctx,
      ctx.keyStore.assertOperator(operatorLabel).account
    )
  }

  /** The `operators` row for an on-chain `account`, from one complete read; absent when there is none. */
  async function findOperatorRow<C extends ClusterBuildContext>(
    ctx: C,
    account: string
  ): Promise<SysioContracts.SysioOpregOperatorEntryType> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .tables.operators.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, OperatorsTable)
    return result.rows.find(row => row.account === account)
  }

  // ── Verify: the `remitclaims{account, token}` row ────────────────────────

  /** Input for {@link planVerifyRemitClaim}. */
  export interface VerifyRemitClaimInput extends StepInput {
    readonly kind: "WireCollateralTool.VerifyRemitClaimInput"
    /** Operator's durable `label` handle — resolved from `ctx.keyStore` (NOT its on-chain `account`). */
    readonly operatorLabel: string
    /** The expected claim: its token and exact balance in depot atomic units. */
    readonly claim: TokenAmount
  }

  /**
   * Assert the operator's `remitclaims{account, token}` row holds exactly `claim.amount` —
   * an exact match, not a minimum. The row accumulates every credit not yet claimed:
   * matured withdrawals, and for `remitclaims{account, WIRE}` also credited shadow yield,
   * termination payouts and lock releases. The caller passes that cumulative expected
   * value, not the amount of the last withdrawal.
   * The row appears at the epoch boundary whose `flushwtdw` matures the withdrawal, so the
   * runner polls for up to {@link RemitClaimEpochCount} effective epochs. A missing row
   * reads as zero, so a zero expectation verifies a claim that `claimremit` has paid.
   */
  export function planVerifyRemitClaim<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    operatorLabel: string,
    claim: TokenAmount
  ): ClusterBuildStep<C, VerifyRemitClaimInput> {
    return ClusterBuildStep.create<C, VerifyRemitClaimInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "WireCollateralTool.VerifyRemitClaimInput",
        operatorLabel,
        claim
      },
      runVerifyRemitClaim
    )
  }

  /** Named runner — poll `remitclaims` until the operator's claim holds the expected balance. */
  export async function runVerifyRemitClaim<C extends ClusterBuildContext>(
    ctx: C,
    input: VerifyRemitClaimInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const account = ctx.keyStore.assertOperator(input.operatorLabel).account,
      { tokenCode, amount } = input.claim
    await pollUntil(
      `${account} remitclaims(${tokenSpelling(tokenCode)}) = ${amount}`,
      async () => (await readRemitClaim(ctx, account, tokenCode)) === amount,
      remitClaimDeadlineMs(ctx.config.epochDurationSec),
      RemitClaimPollIntervalMs
    )
  }

  /**
   * READ an operator's `remitclaims{account, token}` balance — `0n` when there is no row.
   */
  export async function readRemitClaim<C extends ClusterBuildContext>(
    ctx: C,
    account: string,
    tokenCode: bigint
  ): Promise<bigint> {
    const result = await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .tables.remitclaims.query({ limit: TableRowLimit })
    assertCompleteRead(result.more, RemitClaimsTable)
    const claim = result.rows.find(
      row =>
        row.account === account &&
        BigInt(slugValue(row.token_code)) === tokenCode
    )
    return claim == null ? 0n : BigInt(claim.balance)
  }

  /**
   * The {@link planVerifyRemitClaim} deadline for a cluster's epoch duration (ms):
   * {@link RemitClaimEpochCount} effective epochs.
   */
  export function remitClaimDeadlineMs(epochDurationSec: number): number {
    return (
      RemitClaimEpochCount *
      ProtocolTiming.effectiveEpochSec(epochDurationSec) *
      ProtocolTiming.MsPerSecond
    )
  }

  /**
   * The Step ceiling for a {@link planVerifyRemitClaim} Step (ms): its poll deadline
   * ({@link remitClaimDeadlineMs}) plus `ProtocolTiming.PollDeadlineBufferMs`, so the Step's
   * timeout never races the poll it wraps. Pass the same epoch duration the runner reads —
   * a scenario's `plan()` passes `cluster.context.config.epochDurationSec`, the value its
   * runners later read as `ctx.config.epochDurationSec`.
   */
  export function remitClaimStepTimeoutMs(epochDurationSec: number): number {
    return (
      remitClaimDeadlineMs(epochDurationSec) +
      ProtocolTiming.PollDeadlineBufferMs
    )
  }

  // ── value helpers ────────────────────────────────────────────────────────

  /** A WIRE amount on the WIRE chain — the collateral every depot-native bond here moves. */
  export function createWireCollateral(amount: bigint): ChainTokenAmount {
    return {
      chain_code: Constants.WireChainCode,
      amount: createWireClaim(amount)
    }
  }

  /**
   * A WIRE claim amount — what {@link planVerifyRemitClaim} expects `remitclaims{account, WIRE}`
   * to hold, in depot atomic units; `0n` verifies a claim that `claimremit` has paid.
   */
  export function createWireClaim(amount: bigint): TokenAmount {
    return TokenAmount.create({ tokenCode: WireTokenCode, amount })
  }

  /**
   * The `(WIRE, WIRE)` collateral requirement a scenario's `required*Collateral` default
   * carries, which the bootstrap installs as `sysio.opreg::op_config`'s `req_*_collat` entry.
   *
   * @param minimumBond - The minimum bond in depot atomic units.
   * @throws If `minimumBond` is not positive, or exceeds what the persisted number field holds
   *   exactly.
   */
  export function createWireRequirement(
    minimumBond: bigint
  ): CollateralRequirement {
    Assert.ok(
      minimumBond > 0n && minimumBond <= BigInt(Number.MAX_SAFE_INTEGER),
      `WireCollateralTool: a minimum bond must be positive and at most ${Number.MAX_SAFE_INTEGER}, got ${minimumBond}`
    )
    return {
      chainCode: Constants.WireChainCode,
      tokenCode: Constants.WireTokenCode,
      minimumBond: Number(minimumBond)
    }
  }

  /** The canonical slug_name spelling of a packed token code — what the ABI's `slug_name` fields take. */
  export function tokenSpelling(tokenCode: bigint): string {
    return SlugName.toString(Number(tokenCode))
  }

  /** Assert a collateral amount sits on the WIRE chain, where every depot-native row lives. */
  export function assertDepotCollateral(collateral: ChainTokenAmount): void {
    Assert.ok(
      collateral.chain_code === Constants.WireChainCode,
      `WireCollateralTool: depot-native collateral is keyed on the WIRE chain, got ${SlugName.toString(collateral.chain_code)}`
    )
  }

  /** Assert a collateral amount is WIRE on the WIRE chain — the one token the harness can fund. */
  export function assertWireCollateral(collateral: ChainTokenAmount): void {
    assertDepotCollateral(collateral)
    Assert.ok(
      collateral.amount.tokenCode === WireTokenCode,
      `WireCollateralTool: only WIRE has a harness funding path, got ${tokenSpelling(collateral.amount.tokenCode)}`
    )
  }

  /** Table names {@link assertCompleteRead} reports. */
  export const OperatorsTable = "operators"
  /** See {@link OperatorsTable}. */
  export const RemitClaimsTable = "remitclaims"
  /** See {@link OperatorsTable}. */
  export const WithdrawQueueTable = "wtdwqueue"

  /**
   * Refuse a truncated table read. The reads here answer "absent" with zero, so a row past
   * {@link TableRowLimit} would otherwise pass a zero expectation.
   */
  export function assertCompleteRead(more: boolean, table: string): void {
    Assert.ok(
      !more,
      `WireCollateralTool: sysio.opreg::${table} has more than ${TableRowLimit} rows; the read is truncated`
    )
  }

  /** Assert an amount is positive — the runners' guard before any client is touched. */
  function assertPositive(amount: TokenAmount): void {
    Assert.ok(
      amount.amount > 0n,
      `WireCollateralTool: amount must be positive, got ${amount.amount}`
    )
  }
}
