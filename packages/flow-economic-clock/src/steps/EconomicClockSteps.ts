import Assert from "node:assert"

import { match } from "ts-pattern"
import type { ClusterConfig } from "@wireio/cluster-tool-shared"
import { SysioContracts } from "@wireio/sdk-core"
import { getLogger } from "@wireio/shared"
import {
  ClusterBuildStep,
  ProtocolTiming,
  Steps,
  WireClient,
  WireCollateralTool,
  WireEconomicClockTool,
  WireSyndicationTool,
  formatWireAsset,
  matchesProtoEnum,
  outputKey,
  pollFor,
  type ClusterBuildContext,
  type ClusterBuildStepOptions,
  type OutputKey,
  type Report,
  type StepInput
} from "@wireio/cluster-tool"

import { EconomicClockScenarioConstants as Constants } from "../EconomicClockScenarioConstants.js"
import type {
  EconomicClockEmissionsReading,
  EconomicClockHoldSnapshot,
  EconomicClockPayClaimSnapshot,
  EconomicClockReleaseSnapshot,
  EconomicClockWithdrawalSnapshot
} from "../outputs/index.js"

const log = getLogger(__filename)

const {
  SysioContractAccount,
  SysioContractName,
  SysioEpochEmissionsblockreason,
  SysioMsgchChainkind,
  SysioOpregOperatorstatus
} = SysioContracts

/** The treasury account: `sysio`, whose WIRE balance funds every emissions payout. */
const TreasuryAccount = SysioContractAccount[SysioContractName.system]

/**
 * The economic-clock scenario's Steps: the verify Steps over what the clocks did to emissions,
 * withdrawals and pay claims, the treasury drain and refund that hold and release emissions, and
 * the awaits that capture each state the verify Steps assert. Every pure check is exported on its
 * own so the scenario's unit tests drive it without a chain.
 */
export namespace EconomicClockSteps {
  /** The clock whose wait a withdrawal snapshot is taken at, or which still holds the withdrawal. */
  export enum WithdrawalWait {
    economic = "economic",
    consensus = "consensus"
  }

  // ── Output keys ───────────────────────────────────────────────────────────

  /**
   * The `ctx.outputs` key a pay-claim snapshot is stored under.
   *
   * @param snapshotName - The snapshot's name within the scenario.
   * @returns The typed key.
   */
  export function payClaimKey(
    snapshotName: string
  ): OutputKey<EconomicClockPayClaimSnapshot> {
    return outputKey<EconomicClockPayClaimSnapshot>(
      `economicClock.payClaim.${snapshotName}`,
      `an account's liquid WIRE and payclaims before the "${snapshotName}" claimpay`
    )
  }

  /**
   * The `ctx.outputs` key a verified withdrawal request is stored under.
   *
   * @param withdrawalName - The withdrawal's name within the scenario.
   * @returns The typed key.
   */
  export function withdrawalKey(
    withdrawalName: string
  ): OutputKey<SysioContracts.SysioOpregWithdrawRequestType> {
    return outputKey<SysioContracts.SysioOpregWithdrawRequestType>(
      `economicClock.withdrawal.${withdrawalName}`,
      `the "${withdrawalName}" wtdwqueue row as requested`
    )
  }

  /**
   * The `ctx.outputs` key a withdrawal snapshot is stored under.
   *
   * @param withdrawalName - The withdrawal's name within the scenario.
   * @param wait - The wait the snapshot was taken at.
   * @returns The typed key.
   */
  export function withdrawalSnapshotKey(
    withdrawalName: string,
    wait: WithdrawalWait
  ): OutputKey<EconomicClockWithdrawalSnapshot> {
    return outputKey<EconomicClockWithdrawalSnapshot>(
      `economicClock.withdrawal.${withdrawalName}.${wait}`,
      `the "${withdrawalName}" withdrawal as its ${wait} wait passed`
    )
  }

  /**
   * The `ctx.outputs` key an emissions hold is stored under.
   *
   * @param holdName - The hold's name within the scenario.
   * @returns The typed key.
   */
  export function holdKey(
    holdName: string
  ): OutputKey<EconomicClockHoldSnapshot> {
    return outputKey<EconomicClockHoldSnapshot>(
      `economicClock.hold.${holdName}`,
      `the "${holdName}" emissions hold as first observed`
    )
  }

  /**
   * The `ctx.outputs` key the release of an emissions hold is stored under.
   *
   * @param releaseName - The release's name within the scenario.
   * @returns The typed key.
   */
  export function releaseKey(
    releaseName: string
  ): OutputKey<EconomicClockReleaseSnapshot> {
    return outputKey<EconomicClockReleaseSnapshot>(
      `economicClock.release.${releaseName}`,
      `the economic epoch that paid the "${releaseName}" held period`
    )
  }

  // ── Verify: the clocks are configured as the scenario needs ─────────────────

  /**
   * Assert the depot runs the clocks the cluster was configured with: `economycfg` and `epochcfg`
   * carry the resolved durations, the economic epoch is the longer one, every economic epoch is a
   * pay epoch, and the T5 treasury starts where the economic grid does.
   */
  export function planVerifyClockConfiguration<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
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
      runVerifyClockConfiguration
    )
  }

  /** Named runner — read the four singletons and assert them against `ctx.config`. */
  export async function runVerifyClockConfiguration<
    C extends ClusterBuildContext
  >(ctx: C, _input: null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const [economy, consensus, emission, t5] = await Promise.all([
      Steps.contracts.sysio.epoch.readEconomyConfig(ctx),
      Steps.contracts.sysio.epoch.readEpochConfig(ctx),
      Steps.contracts.sysio.system.readEmissionConfig(ctx),
      Steps.contracts.sysio.system.readT5State(ctx)
    ])
    Assert.ok(economy != null, "sysio.epoch::economycfg has no row")
    Assert.ok(consensus != null, "sysio.epoch::epochcfg has no row")
    Assert.strictEqual(
      economy.epoch_duration_sec,
      ctx.config.economicEpochDurationSec,
      "economycfg.epoch_duration_sec is not the cluster's economic epoch duration"
    )
    Assert.strictEqual(
      consensus.epoch_duration_sec,
      ctx.config.epochDurationSec,
      "epochcfg.epoch_duration_sec is not the cluster's consensus epoch duration"
    )
    Assert.ok(
      economy.epoch_duration_sec > consensus.epoch_duration_sec,
      `the economic epoch (${economy.epoch_duration_sec} s) must be longer than the consensus epoch (${consensus.epoch_duration_sec} s)`
    )
    Assert.strictEqual(
      emission.pay_cadence_epochs,
      Constants.PayCadenceEpochs,
      "every economic epoch must be a pay epoch"
    )
    Assert.strictEqual(
      WireClient.chainTimeMs(t5.start_time),
      WireClient.chainTimeMs(economy.start_time),
      "t5state starts somewhere other than the economic clock's grid"
    )
  }

  // ── Verify: emissions pay on economic epochs ─────────────────────────────

  /** Input of the Steps that assert over one {@link WireEconomicClockTool.Observation}. */
  export interface ObservationInput extends StepInput {
    readonly kind: "EconomicClockSteps.ObservationInput"
    /** The observation's name ({@link WireEconomicClockTool.observationKey}). */
    readonly observationName: string
  }

  /**
   * Assert every economic epoch the observation saw open paid its period
   * ({@link assertEmissionsPaidPerEconomicEpoch}) and no emissions block is open.
   */
  export function planVerifyEmissionsPaidPerEconomicEpoch<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    observationName: string
  ): ClusterBuildStep<C, ObservationInput> {
    return ClusterBuildStep.create<C, ObservationInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.ObservationInput", observationName },
      runVerifyEmissionsPaidPerEconomicEpoch
    )
  }

  /** Named runner — read `epochlog`, `blocklog` and `t5state`, then assert the observation. */
  export async function runVerifyEmissionsPaidPerEconomicEpoch<
    C extends ClusterBuildContext
  >(ctx: C, input: ObservationInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const observation = ctx.outputs.assert(
        WireEconomicClockTool.observationKey(input.observationName)
      ),
      [epochLog, blockLog, t5] = await Promise.all([
        Steps.contracts.sysio.system.readEpochLog(ctx),
        Steps.contracts.sysio.epoch.readBlockLog(ctx),
        Steps.contracts.sysio.system.readT5State(ctx)
      ]),
      paid = assertEmissionsPaidPerEconomicEpoch(observation, epochLog)
    Assert.deepStrictEqual(blockLog, [], "an emissions block episode is open")
    Assert.ok(
      BigInt(t5.epoch_count) >= BigInt(paid.at(-1).epoch_count),
      "t5state.epoch_count is behind the epochlog"
    )
  }

  /**
   * Assert one `epochlog` payment per economic epoch the observation saw open: a row keyed by
   * each tick's economic epoch index, with a positive total, and consecutive payment counts —
   * every economic epoch paid exactly one period.
   *
   * @param observation - The economic epochs that opened.
   * @param epochLog - Every `sysio::epochlog` row.
   * @returns The payment rows, one per tick, in order.
   * @throws When an economic epoch paid nothing, or the payments are not one per epoch.
   */
  export function assertEmissionsPaidPerEconomicEpoch(
    observation: WireEconomicClockTool.Observation,
    epochLog: readonly SysioContracts.SysioSystemEpochLogType[]
  ): SysioContracts.SysioSystemEpochLogType[] {
    Assert.ok(observation.ticks.length >= 1, "no economic epoch opened")
    const paid = observation.ticks.map(tick => {
      const row = epochLog.find(
        entry => entry.economic_epoch_index === tick.economicEpochIndex
      )
      Assert.ok(
        row != null,
        `economic epoch ${tick.economicEpochIndex} paid no period`
      )
      Assert.ok(
        BigInt(row.total_emission) > 0n,
        `economic epoch ${tick.economicEpochIndex} paid an empty period`
      )
      return row
    })
    paid
      .slice(1)
      .forEach((row, index) =>
        Assert.strictEqual(
          BigInt(row.epoch_count),
          BigInt(paid[index].epoch_count) + 1n,
          `economic epoch ${row.economic_epoch_index} is not the payment after economic epoch ${paid[index].economic_epoch_index}`
        )
      )
    return paid
  }

  // ── Verify: consensus advances about twice per economic epoch ────────────

  /**
   * Assert consensus advanced, between the observation's first and last economic epoch, at least
   * as often as the consensus envelope requires and more often than the economic clock
   * ({@link assertConsensusCadence}).
   */
  export function planVerifyConsensusCadence<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    observationName: string
  ): ClusterBuildStep<C, ObservationInput> {
    return ClusterBuildStep.create<C, ObservationInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.ObservationInput", observationName },
      runVerifyConsensusCadence
    )
  }

  /** Named runner — assert the stored observation with {@link assertConsensusCadence}. */
  export async function runVerifyConsensusCadence<
    C extends ClusterBuildContext
  >(ctx: C, input: ObservationInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    assertConsensusCadence(
      ctx.outputs.assert(
        WireEconomicClockTool.observationKey(input.observationName)
      ),
      ctx.config.epochDurationSec
    )
  }

  /**
   * Assert the two clocks ran on separate grids: between the observation's first and last tick,
   * consensus advanced unpaused at least `WireEconomicClockTool.consensusAdvanceLowerBound`
   * epochs, and more than the economic epochs that opened.
   *
   * @param observation - At least two economic epochs opening.
   * @param consensusEpochDurationSec - The cluster's consensus epoch duration (s).
   * @returns The consensus epochs advanced over the window.
   * @throws When the observation is too short, or consensus fell behind either bound.
   */
  export function assertConsensusCadence(
    observation: WireEconomicClockTool.Observation,
    consensusEpochDurationSec: number
  ): number {
    Assert.ok(
      observation.ticks.length >= 2,
      "too few economic epochs to time consensus against"
    )
    const [first] = observation.ticks,
      last = observation.ticks.at(-1),
      consensusAdvanced = WireEconomicClockTool.assertConsensusAdvanced(
        first,
        last,
        consensusEpochDurationSec
      ),
      economicAdvanced = last.economicEpochIndex - first.economicEpochIndex
    Assert.ok(
      consensusAdvanced > economicAdvanced,
      `consensus advanced ${consensusAdvanced} epoch(s) while the economic clock opened ${economicAdvanced}`
    )
    log.info(
      `[economic-clock] ${consensusAdvanced} consensus epochs per ${economicAdvanced} economic epochs`
    )
    return consensusAdvanced
  }

  // ── Record / verify: an account's epoch pay around a claimpay ─────────────

  /** Input of {@link planRecordPayClaim} and {@link planVerifyPayClaimPaid}. */
  export interface PayClaimInput extends StepInput {
    readonly kind: "EconomicClockSteps.PayClaimInput"
    /** The claiming account. */
    readonly account: string
    /** The snapshot's name ({@link payClaimKey}). */
    readonly snapshotName: string
  }

  /**
   * Record the account's liquid WIRE, its `payclaims` balance and the economic epoch — a read,
   * carried by a Step because the verify after the `claimpay` compares against it. Place it
   * right after an economic epoch opens, so no tick lands before the claim. Fails when
   * `payepoch` has credited the account nothing.
   */
  export function planRecordPayClaim<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    snapshotName: string
  ): ClusterBuildStep<C, PayClaimInput> {
    return ClusterBuildStep.create<C, PayClaimInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.PayClaimInput", account, snapshotName },
      runRecordPayClaim
    )
  }

  /** Named runner — read and store the account's {@link EconomicClockPayClaimSnapshot}. */
  export async function runRecordPayClaim<C extends ClusterBuildContext>(
    ctx: C,
    input: PayClaimInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const snapshot = await readPayClaimSnapshot(ctx, input.account)
    Assert.ok(
      snapshot.payClaim > 0n,
      `payepoch credited ${input.account} no epoch pay`
    )
    ctx.outputs.set(payClaimKey(input.snapshotName), snapshot)
  }

  /**
   * Assert the `claimpay` paid the account its whole recorded claim ({@link assertPayClaimPaid}).
   */
  export function planVerifyPayClaimPaid<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    account: string,
    snapshotName: string
  ): ClusterBuildStep<C, PayClaimInput> {
    return ClusterBuildStep.create<C, PayClaimInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.PayClaimInput", account, snapshotName },
      runVerifyPayClaimPaid
    )
  }

  /** Named runner — read the account again and compare with the recorded snapshot. */
  export async function runVerifyPayClaimPaid<C extends ClusterBuildContext>(
    ctx: C,
    input: PayClaimInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertPayClaimPaid(
      ctx.outputs.assert(payClaimKey(input.snapshotName)),
      await readPayClaimSnapshot(ctx, input.account)
    )
  }

  /** READ an account's {@link EconomicClockPayClaimSnapshot}. */
  async function readPayClaimSnapshot<C extends ClusterBuildContext>(
    ctx: C,
    account: string
  ): Promise<EconomicClockPayClaimSnapshot> {
    const [balance, payClaim, economy] = await Promise.all([
      ctx.wire.getWireBalance(account),
      ctx.wire.getPayClaimable(account),
      Steps.contracts.sysio.epoch.readEconomyState(ctx)
    ])
    return {
      balance,
      payClaim,
      economicEpochIndex: economy?.current_epoch_index ?? 0
    }
  }

  /**
   * Assert a `claimpay` drained the recorded claim into the account's liquid WIRE. With no
   * economic epoch opening between the two snapshots the payout is exact and the row is gone; when
   * one opened, its `payepoch` credited more first, so the payout is at least the recorded claim.
   *
   * @param before - The snapshot before the claim.
   * @param after - The snapshot after it.
   * @throws When the claim paid less than recorded, or more with no economic epoch between.
   */
  export function assertPayClaimPaid(
    before: EconomicClockPayClaimSnapshot,
    after: EconomicClockPayClaimSnapshot
  ): void {
    const received = after.balance - before.balance
    match(after.economicEpochIndex === before.economicEpochIndex)
      .with(true, () => {
        Assert.strictEqual(
          received,
          before.payClaim,
          "claimpay paid other than the recorded claim"
        )
        Assert.strictEqual(
          after.payClaim,
          0n,
          "claimpay left part of the claim in payclaims"
        )
      })
      .with(false, () =>
        Assert.ok(
          received >= before.payClaim,
          `claimpay paid ${received}, less than the recorded claim of ${before.payClaim}`
        )
      )
      .exhaustive()
  }

  // ── Verify: an operator's status ─────────────────────────────────────────

  /** Input of {@link planVerifyOperatorStatus}. */
  export interface OperatorStatusInput extends StepInput {
    readonly kind: "EconomicClockSteps.OperatorStatusInput"
    /** The operator's durable label. */
    readonly label: string
    /** The status its `sysio.opreg::operators` row must carry. */
    readonly status: SysioContracts.SysioOpregOperatorstatus
  }

  /** Assert the operator's `sysio.opreg` row carries `status`. */
  export function planVerifyOperatorStatus<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    status: SysioContracts.SysioOpregOperatorstatus
  ): ClusterBuildStep<C, OperatorStatusInput> {
    return ClusterBuildStep.create<C, OperatorStatusInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.OperatorStatusInput", label, status },
      runVerifyOperatorStatus
    )
  }

  /** Named runner — read the operator's row and compare its status. */
  export async function runVerifyOperatorStatus<C extends ClusterBuildContext>(
    ctx: C,
    input: OperatorStatusInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const row = await WireCollateralTool.readOperatorRow(ctx, input.label)
    Assert.ok(row != null, `${input.label} has no sysio.opreg::operators row`)
    Assert.ok(
      matchesProtoEnum(row.status, SysioOpregOperatorstatus, input.status),
      `${input.label} is ${String(row.status)}, not ${SysioOpregOperatorstatus[input.status]}`
    )
  }

  // ── Withdrawals: eligibility, the two waits, maturity ─────────────────────

  /** Input of {@link planVerifyWithdrawalEligibility}. */
  export interface WithdrawalEligibilityInput extends StepInput {
    readonly kind: "EconomicClockSteps.WithdrawalEligibilityInput"
    /** The withdrawing operator's durable label. */
    readonly label: string
    /** The amount requested (WIRE base units). */
    readonly amount: bigint
    /** The clocks recorded right before the request ({@link WireEconomicClockTool.observationKey}). */
    readonly observationName: string
    /** The name the verified request is stored under ({@link withdrawalKey}). */
    readonly withdrawalName: string
  }

  /**
   * Assert the operator's queued withdrawal carries both eligibility fields — the economic wait
   * from the economic epoch of the request and the consensus guard from the consensus epoch of it
   * ({@link assertWithdrawalEligibility}) — and store it for the Steps after.
   */
  export function planVerifyWithdrawalEligibility<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    amount: bigint,
    observationName: string,
    withdrawalName: string
  ): ClusterBuildStep<C, WithdrawalEligibilityInput> {
    return ClusterBuildStep.create<C, WithdrawalEligibilityInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EconomicClockSteps.WithdrawalEligibilityInput",
        label,
        amount,
        observationName,
        withdrawalName
      },
      runVerifyWithdrawalEligibility
    )
  }

  /** Named runner — read the queued row and both clocks, assert, store the row. */
  export async function runVerifyWithdrawalEligibility<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: WithdrawalEligibilityInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const account = ctx.keyStore.assertOperator(input.label).account,
      requests = await WireCollateralTool.readWithdrawRequests(ctx, account),
      before = WireEconomicClockTool.latestReading(
        ctx.outputs.assert(
          WireEconomicClockTool.observationKey(input.observationName)
        )
      ),
      after = await WireEconomicClockTool.readReading(ctx)
    Assert.strictEqual(
      requests.length,
      1,
      `${account} must have exactly one queued withdrawal`
    )
    const [request] = requests
    assertWithdrawalEligibility(request, input.amount, before, after)
    ctx.outputs.set(withdrawalKey(input.withdrawalName), request)
  }

  /**
   * Assert a queued withdrawal's eligibility: its amount, its economic wait of
   * {@link EconomicClockScenarioConstants.WithdrawWaitEconomicEpochs} counted from the economic
   * epoch the request fell in (at most one boundary past the last tick read after it), and its
   * consensus guard of {@link EconomicClockScenarioConstants.WithdrawWaitConsensusEpochs} counted
   * from a consensus epoch between the two readings that bracket the request.
   *
   * @param request - The `wtdwqueue` row.
   * @param amount - The amount requested.
   * @param before - Both clocks right before the request.
   * @param after - Both clocks right after it.
   * @throws When either field does not follow from the clocks.
   */
  export function assertWithdrawalEligibility(
    request: SysioContracts.SysioOpregWithdrawRequestType,
    amount: bigint,
    before: WireEconomicClockTool.Reading,
    after: WireEconomicClockTool.Reading
  ): void {
    const requestedAt = request.requested_at_economic_epoch,
      latestRequestEpoch =
        after.economicEpochIndex + Constants.UntickedEconomicBoundaries,
      consensusAtRequest =
        request.eligible_at_consensus_epoch -
        Constants.WithdrawWaitConsensusEpochs
    Assert.strictEqual(
      BigInt(request.amount),
      amount,
      "the queued withdrawal has another amount"
    )
    Assert.ok(
      requestedAt >= before.economicEpochIndex &&
        requestedAt <= latestRequestEpoch,
      `requested at economic epoch ${requestedAt}, outside ${before.economicEpochIndex}..${latestRequestEpoch}`
    )
    Assert.strictEqual(
      request.eligible_at_economic_epoch,
      requestedAt + Constants.WithdrawWaitEconomicEpochs,
      "eligible_at_economic_epoch is not the economic wait after the request"
    )
    Assert.ok(
      consensusAtRequest >= before.consensusEpochIndex &&
        consensusAtRequest <= after.consensusEpochIndex,
      `eligible_at_consensus_epoch ${request.eligible_at_consensus_epoch} is not the consensus guard after a consensus epoch in ${before.consensusEpochIndex}..${after.consensusEpochIndex}`
    )
  }

  /** Input of {@link planAwaitWithdrawalWaitPassed}. */
  export interface AwaitWithdrawalWaitInput extends StepInput {
    readonly kind: "EconomicClockSteps.AwaitWithdrawalWaitInput"
    /** The withdrawing operator's durable label. */
    readonly label: string
    /** The verified request ({@link withdrawalKey}). */
    readonly withdrawalName: string
    /** The wait to await. */
    readonly wait: WithdrawalWait
  }

  /**
   * Poll until the withdrawal's `wait` has passed — the economic index reached
   * `eligible_at_economic_epoch`, or the consensus index `eligible_at_consensus_epoch` — and store
   * an {@link EconomicClockWithdrawalSnapshot} of that instant ({@link withdrawalSnapshotKey}).
   * Pair it with {@link withdrawalWaitStepTimeoutMs}.
   */
  export function planAwaitWithdrawalWaitPassed<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    withdrawalName: string,
    wait: WithdrawalWait
  ): ClusterBuildStep<C, AwaitWithdrawalWaitInput> {
    return ClusterBuildStep.create<C, AwaitWithdrawalWaitInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EconomicClockSteps.AwaitWithdrawalWaitInput",
        label,
        withdrawalName,
        wait
      },
      runAwaitWithdrawalWaitPassed
    )
  }

  /** Named runner — poll for a consistent snapshot in which the wait has passed, then store it. */
  export async function runAwaitWithdrawalWaitPassed<
    C extends ClusterBuildContext
  >(
    ctx: C,
    input: AwaitWithdrawalWaitInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const request = ctx.outputs.assert(withdrawalKey(input.withdrawalName)),
      account = ctx.keyStore.assertOperator(input.label).account,
      snapshot = await pollFor(
        `the ${input.wait} wait of withdrawal ${request.request_id} passes`,
        async () => {
          const snapshot = await readWithdrawalSnapshot(ctx, account, request)
          return snapshot != null &&
            waitPassed(request, snapshot.reading, input.wait)
            ? snapshot
            : null
        },
        withdrawalWaitDeadlineMs(ctx.config, input.wait),
        WireEconomicClockTool.PollIntervalMs
      )
    log.info(
      `[economic-clock] withdrawal ${request.request_id}: ${input.wait} wait passed at economic epoch ` +
        `${snapshot.reading.economicEpochIndex}, consensus epoch ${snapshot.reading.consensusEpochIndex}; ` +
        `${snapshot.queued ? "still queued" : "flushed"}`
    )
    ctx.outputs.set(
      withdrawalSnapshotKey(input.withdrawalName, input.wait),
      snapshot
    )
  }

  /**
   * READ a withdrawal snapshot: both clocks, the queue and the remit claim, then both clocks
   * again. Absent when the clocks moved between the two readings, so a snapshot never mixes two
   * states.
   */
  async function readWithdrawalSnapshot<C extends ClusterBuildContext>(
    ctx: C,
    account: string,
    request: SysioContracts.SysioOpregWithdrawRequestType
  ): Promise<EconomicClockWithdrawalSnapshot> {
    const reading = await WireEconomicClockTool.readReading(ctx),
      queued = (
        await WireCollateralTool.readWithdrawRequests(ctx, account)
      ).some(row => BigInt(row.request_id) === BigInt(request.request_id)),
      remitClaim = await WireCollateralTool.readRemitClaim(
        ctx,
        account,
        WireCollateralTool.WireTokenCode
      ),
      confirm = await WireEconomicClockTool.readReading(ctx)
    return confirm.economicEpochIndex === reading.economicEpochIndex &&
      confirm.consensusEpochIndex === reading.consensusEpochIndex
      ? { reading, queued, remitClaim }
      : null
  }

  /**
   * Whether `wait` of the request has passed at `reading`.
   *
   * @param request - The `wtdwqueue` row.
   * @param reading - Both clocks.
   * @param wait - The wait to test.
   * @returns `true` once the clock has reached the request's eligibility for it.
   */
  export function waitPassed(
    request: SysioContracts.SysioOpregWithdrawRequestType,
    reading: WireEconomicClockTool.Reading,
    wait: WithdrawalWait
  ): boolean {
    return match(wait)
      .with(
        WithdrawalWait.economic,
        () => reading.economicEpochIndex >= request.eligible_at_economic_epoch
      )
      .with(
        WithdrawalWait.consensus,
        () => reading.consensusEpochIndex >= request.eligible_at_consensus_epoch
      )
      .exhaustive()
  }

  /**
   * The deadline of {@link planAwaitWithdrawalWaitPassed} (ms): the wait's epochs of its clock,
   * plus {@link EconomicClockScenarioConstants.RequestEpochs} for the epoch the request fell in.
   *
   * @param config - The resolved cluster config.
   * @param wait - The wait awaited.
   * @returns The poll deadline (ms).
   */
  export function withdrawalWaitDeadlineMs(
    config: ClusterConfig,
    wait: WithdrawalWait
  ): number {
    return match(wait)
      .with(
        WithdrawalWait.economic,
        () =>
          (Constants.WithdrawWaitEconomicEpochs + Constants.RequestEpochs) *
          WireEconomicClockTool.economicEpochWaitMs(
            config.economicEpochDurationSec
          )
      )
      .with(
        WithdrawalWait.consensus,
        () =>
          (Constants.WithdrawWaitConsensusEpochs + Constants.RequestEpochs) *
          ProtocolTiming.effectiveEpochSec(config.epochDurationSec) *
          ProtocolTiming.MsPerSecond
      )
      .exhaustive()
  }

  /**
   * The Step ceiling of {@link planAwaitWithdrawalWaitPassed} (ms): its deadline plus the poll
   * margin. Pass the config the runner reads — `cluster.context.config` at plan time.
   *
   * @param config - The resolved cluster config.
   * @param wait - The wait awaited.
   * @returns The Step's `timeoutMs`.
   */
  export function withdrawalWaitStepTimeoutMs(
    config: ClusterConfig,
    wait: WithdrawalWait
  ): number {
    return (
      withdrawalWaitDeadlineMs(config, wait) +
      ProtocolTiming.PollDeadlineBufferMs
    )
  }

  /** Input of {@link planVerifyWithdrawalHeld}. */
  export interface WithdrawalHeldInput extends StepInput {
    readonly kind: "EconomicClockSteps.WithdrawalHeldInput"
    /** The verified request ({@link withdrawalKey}). */
    readonly withdrawalName: string
    /** The wait the snapshot was taken at — the wait that passed. */
    readonly passed: WithdrawalWait
    /** The operator's WIRE remit claim the snapshot must show (base units). */
    readonly remitClaim: bigint
  }

  /**
   * Assert that when the `passed` wait passed, the OTHER clock still held the withdrawal: it was
   * still queued and the remit claim unchanged ({@link assertWithdrawalHeld}).
   */
  export function planVerifyWithdrawalHeld<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    withdrawalName: string,
    passed: WithdrawalWait,
    remitClaim: bigint
  ): ClusterBuildStep<C, WithdrawalHeldInput> {
    return ClusterBuildStep.create<C, WithdrawalHeldInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EconomicClockSteps.WithdrawalHeldInput",
        withdrawalName,
        passed,
        remitClaim
      },
      runVerifyWithdrawalHeld
    )
  }

  /** Named runner — assert the stored snapshot with {@link assertWithdrawalHeld}. */
  export async function runVerifyWithdrawalHeld<C extends ClusterBuildContext>(
    ctx: C,
    input: WithdrawalHeldInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertWithdrawalHeld(
      ctx.outputs.assert(withdrawalKey(input.withdrawalName)),
      ctx.outputs.assert(
        withdrawalSnapshotKey(input.withdrawalName, input.passed)
      ),
      input.passed,
      input.remitClaim
    )
  }

  /**
   * Assert a withdrawal did not mature on one wait alone: at the snapshot the `passed` wait had
   * passed, the other had not, the request was still queued and the remit claim was unchanged.
   *
   * @param request - The `wtdwqueue` row.
   * @param snapshot - The snapshot taken as the `passed` wait passed.
   * @param passed - The wait that passed.
   * @param remitClaim - The remit claim the operator held before the request matured.
   * @throws When the other wait had also passed, or the withdrawal matured anyway.
   */
  export function assertWithdrawalHeld(
    request: SysioContracts.SysioOpregWithdrawRequestType,
    snapshot: EconomicClockWithdrawalSnapshot,
    passed: WithdrawalWait,
    remitClaim: bigint
  ): void {
    const other = match(passed)
      .with(WithdrawalWait.economic, () => WithdrawalWait.consensus)
      .with(WithdrawalWait.consensus, () => WithdrawalWait.economic)
      .exhaustive()
    Assert.ok(
      waitPassed(request, snapshot.reading, passed),
      `the snapshot was taken before the ${passed} wait passed`
    )
    Assert.ok(
      !waitPassed(request, snapshot.reading, other),
      `the ${other} wait had also passed, so the snapshot shows nothing held`
    )
    Assert.ok(
      snapshot.queued,
      `the withdrawal matured on its ${passed} wait alone`
    )
    Assert.strictEqual(
      snapshot.remitClaim,
      remitClaim,
      `the remit claim moved while the ${other} clock held the withdrawal`
    )
  }

  /** Input of {@link planVerifyWithdrawalMatured}. */
  export interface WithdrawalMaturedInput extends StepInput {
    readonly kind: "EconomicClockSteps.WithdrawalMaturedInput"
    /** The withdrawing operator's durable label. */
    readonly label: string
    /** The verified request ({@link withdrawalKey}). */
    readonly withdrawalName: string
  }

  /**
   * Assert the withdrawal left the queue only once both waits had passed
   * ({@link assertWithdrawalMatured}).
   */
  export function planVerifyWithdrawalMatured<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    label: string,
    withdrawalName: string
  ): ClusterBuildStep<C, WithdrawalMaturedInput> {
    return ClusterBuildStep.create<C, WithdrawalMaturedInput>(
      actor,
      name,
      description,
      options,
      {
        kind: "EconomicClockSteps.WithdrawalMaturedInput",
        label,
        withdrawalName
      },
      runVerifyWithdrawalMatured
    )
  }

  /** Named runner — read the queue and both clocks, then assert. */
  export async function runVerifyWithdrawalMatured<
    C extends ClusterBuildContext
  >(ctx: C, input: WithdrawalMaturedInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const request = ctx.outputs.assert(withdrawalKey(input.withdrawalName)),
      account = ctx.keyStore.assertOperator(input.label).account,
      queue = await WireCollateralTool.readWithdrawRequests(ctx, account)
    assertWithdrawalMatured(
      request,
      queue,
      await WireEconomicClockTool.readReading(ctx)
    )
  }

  /**
   * Assert a withdrawal matured: it is no longer queued, and both clocks have reached its
   * eligibility.
   *
   * @param request - The `wtdwqueue` row as requested.
   * @param queue - The operator's queued withdrawals now.
   * @param reading - Both clocks now.
   * @throws When the request is still queued, or either clock is short of its eligibility.
   */
  export function assertWithdrawalMatured(
    request: SysioContracts.SysioOpregWithdrawRequestType,
    queue: readonly SysioContracts.SysioOpregWithdrawRequestType[],
    reading: WireEconomicClockTool.Reading
  ): void {
    Assert.ok(
      !queue.some(row => BigInt(row.request_id) === BigInt(request.request_id)),
      `withdrawal ${request.request_id} is still queued`
    )
    Object.values(WithdrawalWait).forEach(wait =>
      Assert.ok(
        waitPassed(request, reading, wait),
        `withdrawal ${request.request_id} left the queue before its ${wait} wait passed`
      )
    )
  }

  // ── Treasury: drain and refund sysio's spendable WIRE ────────────────────

  /**
   * `sysio`'s spendable WIRE, not floored: its balance less the pay credited and not claimed and
   * the batch emission still settling — what the emissions readiness gate spends against
   * (`sysio.system` `spendable_wire`).
   *
   * @param balance - `sysio`'s liquid WIRE.
   * @param outstandingPay - `payclaimtot.outstanding`.
   * @param unsettledBatchEmission - `t5state.unsettled_batch_emission`.
   * @returns The spendable WIRE; negative when the reserves exceed the balance.
   */
  export function spendableWire(
    balance: bigint,
    outstandingPay: bigint,
    unsettledBatchEmission: bigint
  ): bigint {
    return balance - outstandingPay - unsettledBatchEmission
  }

  /** READ `sysio`'s {@link spendableWire}. */
  async function readSpendableWire<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<bigint> {
    const [balance, outstandingPay, t5] = await Promise.all([
      ctx.wire.getWireBalance(TreasuryAccount),
      Steps.contracts.sysio.system.readOutstandingPay(ctx),
      Steps.contracts.sysio.system.readT5State(ctx)
    ])
    return spendableWire(
      balance,
      outstandingPay,
      BigInt(t5.unsettled_batch_emission)
    )
  }

  /** Input of {@link planDrainSpendableWire} and {@link planRefundSpendableWire}. */
  export interface TreasuryTransferInput extends StepInput {
    readonly kind: "EconomicClockSteps.TreasuryTransferInput"
    /** The account holding the drained WIRE. */
    readonly holder: string
  }

  /**
   * Move every unit of `sysio`'s spendable WIRE to `holder` in one transfer, so the next pay
   * epoch's period total exceeds what the treasury can spend — the reserves for credited pay stay
   * behind. Stores the amount under {@link EconomicClockScenarioConstants.DrainedWire}. Place it
   * right after an economic epoch opens.
   */
  export function planDrainSpendableWire<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    holder: string
  ): ClusterBuildStep<C, TreasuryTransferInput> {
    return ClusterBuildStep.create<C, TreasuryTransferInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.TreasuryTransferInput", holder },
      runDrainSpendableWire
    )
  }

  /** Named runner — size the drain from the treasury, then ONE `sysio.token::transfer`. */
  export async function runDrainSpendableWire<C extends ClusterBuildContext>(
    ctx: C,
    input: TreasuryTransferInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const spendable = await readSpendableWire(ctx)
    Assert.ok(
      spendable > 0n,
      `sysio has no spendable WIRE to drain (${spendable})`
    )
    await Steps.contracts.sysio.token.runTransfer(
      ctx,
      {
        kind: "TokenContractSteps.TransferInput",
        data: {
          from: TreasuryAccount,
          to: input.holder,
          quantity: formatWireAsset(spendable),
          memo: Constants.DrainMemo
        }
      },
      signal
    )
    ctx.outputs.set(Constants.DrainedWire, spendable)
  }

  /** Assert `sysio` has no spendable WIRE left. */
  export function planVerifySpendableWireDrained<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
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
      runVerifySpendableWireDrained
    )
  }

  /** Named runner — read the spendable WIRE and assert none is left. */
  export async function runVerifySpendableWireDrained<
    C extends ClusterBuildContext
  >(ctx: C, _input: null, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const spendable = await readSpendableWire(ctx)
    Assert.ok(spendable <= 0n, `sysio still has ${spendable} spendable WIRE`)
  }

  /** Return the drained WIRE from `holder` to `sysio` in one transfer. */
  export function planRefundSpendableWire<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    holder: string
  ): ClusterBuildStep<C, TreasuryTransferInput> {
    return ClusterBuildStep.create<C, TreasuryTransferInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.TreasuryTransferInput", holder },
      runRefundSpendableWire
    )
  }

  /** Named runner — ONE `sysio.token::transfer` of the drained amount back to `sysio`. */
  export async function runRefundSpendableWire<C extends ClusterBuildContext>(
    ctx: C,
    input: TreasuryTransferInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await Steps.contracts.sysio.token.runTransfer(
      ctx,
      {
        kind: "TokenContractSteps.TransferInput",
        data: {
          from: input.holder,
          to: TreasuryAccount,
          quantity: formatWireAsset(ctx.outputs.assert(Constants.DrainedWire)),
          memo: Constants.RefundMemo
        }
      },
      signal
    )
  }

  // ── Emissions hold: observed, held across the clocks, released ───────────

  /**
   * The deadline of the hold and release awaits (ms):
   * {@link EconomicClockScenarioConstants.HoldEpochBudget} economic epochs.
   *
   * @param economicEpochDurationSec - The cluster's economic epoch duration (s).
   * @returns The poll deadline (ms).
   */
  export function emissionsWaitDeadlineMs(
    economicEpochDurationSec: number
  ): number {
    return (
      Constants.HoldEpochBudget *
      WireEconomicClockTool.economicEpochWaitMs(economicEpochDurationSec)
    )
  }

  /**
   * The Step ceiling of the hold and release awaits (ms). Pass
   * `cluster.context.config.economicEpochDurationSec` — the value the runners read.
   *
   * @param economicEpochDurationSec - The cluster's economic epoch duration (s).
   * @returns The Step's `timeoutMs`.
   */
  export function emissionsWaitStepTimeoutMs(
    economicEpochDurationSec: number
  ): number {
    return (
      emissionsWaitDeadlineMs(economicEpochDurationSec) +
      ProtocolTiming.PollDeadlineBufferMs
    )
  }

  /** Input of the Steps over one emissions hold. */
  export interface HoldInput extends StepInput {
    readonly kind: "EconomicClockSteps.HoldInput"
    /** The hold's name ({@link holdKey}). */
    readonly holdName: string
  }

  /**
   * Poll until the readiness gate holds a pay epoch for want of spendable WIRE — a
   * `BALANCE_INSUFFICIENT` block episode in `blocklog` — and store an
   * {@link EconomicClockHoldSnapshot} ({@link holdKey}). Pair it with
   * {@link emissionsWaitStepTimeoutMs}.
   */
  export function planAwaitEmissionsHeld<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    holdName: string
  ): ClusterBuildStep<C, HoldInput> {
    return ClusterBuildStep.create<C, HoldInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.HoldInput", holdName },
      runAwaitEmissionsHeld
    )
  }

  /** Named runner — poll for a consistent ledger whose block episode is BALANCE_INSUFFICIENT. */
  export async function runAwaitEmissionsHeld<C extends ClusterBuildContext>(
    ctx: C,
    input: HoldInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const hold = await pollFor(
      "the readiness gate holds a pay epoch for want of spendable WIRE",
      async () => {
        const reading = await WireEconomicClockTool.readReading(ctx),
          ledger = await readEmissionsReading(ctx),
          envelopeLog = await readEnvelopeLog(ctx),
          [blockLog] = ledger?.blockLog ?? []
        return blockLog != null &&
          isBalanceInsufficient(blockLog) &&
          blockLog.last_epoch_index === reading.economicEpochIndex
          ? {
              blockLog,
              t5: ledger.t5,
              reading,
              envelopeLogTip: envelopeLogTip(envelopeLog)
            }
          : null
      },
      emissionsWaitDeadlineMs(ctx.config.economicEpochDurationSec),
      WireEconomicClockTool.PollIntervalMs
    )
    log.info(
      `[economic-clock] emissions held at economic epoch ${hold.blockLog.epoch_index}: ` +
        `attempted ${hold.blockLog.attempted_emission}, spendable ${hold.blockLog.sysio_balance}`
    )
    ctx.outputs.set(holdKey(input.holdName), hold)
  }

  /**
   * READ the emissions ledger: `t5state`, `blocklog`, then `t5state` again. Absent when an
   * economic epoch opened between the reads, so the reading never mixes two ticks.
   */
  async function readEmissionsReading<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<EconomicClockEmissionsReading> {
    const t5 = await Steps.contracts.sysio.system.readT5State(ctx),
      blockLog = await Steps.contracts.sysio.epoch.readBlockLog(ctx),
      confirm = await Steps.contracts.sysio.system.readT5State(ctx)
    return confirm.last_epoch_index === t5.last_epoch_index
      ? { t5, blockLog }
      : null
  }

  /**
   * Whether a block episode's reason is `EMISSIONS_BLOCK_REASON_BALANCE_INSUFFICIENT`.
   *
   * @param blockLog - The `blocklog` row.
   * @returns `true` when the gate held the epoch for want of spendable WIRE.
   */
  export function isBalanceInsufficient(
    blockLog: SysioContracts.SysioEpochBlocklogEntryType
  ): boolean {
    return matchesProtoEnum(
      blockLog.reason,
      SysioEpochEmissionsblockreason,
      SysioEpochEmissionsblockreason.EMISSIONS_BLOCK_REASON_BALANCE_INSUFFICIENT
    )
  }

  /** Assert the observed hold ({@link assertEmissionsHeld}). */
  export function planVerifyEmissionsHeld<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    holdName: string
  ): ClusterBuildStep<C, HoldInput> {
    return ClusterBuildStep.create<C, HoldInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.HoldInput", holdName },
      runVerifyEmissionsHeld
    )
  }

  /** Named runner — read `epochlog` and assert the stored hold. */
  export async function runVerifyEmissionsHeld<C extends ClusterBuildContext>(
    ctx: C,
    input: HoldInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertEmissionsHeld(
      ctx.outputs.assert(holdKey(input.holdName)),
      await Steps.contracts.sysio.system.readEpochLog(ctx)
    )
  }

  /**
   * Assert a hold for want of WIRE: the gate attempted more than `sysio` could spend, the held
   * economic epochs still accrued exactly that period total into `t5state`, the held period began
   * at the first blocked epoch, and no held epoch paid.
   *
   * @param hold - The hold as first observed.
   * @param epochLog - Every `sysio::epochlog` row.
   * @throws When any of these does not hold.
   */
  export function assertEmissionsHeld(
    hold: EconomicClockHoldSnapshot,
    epochLog: readonly SysioContracts.SysioSystemEpochLogType[]
  ): void {
    const { blockLog, t5 } = hold
    Assert.ok(
      isBalanceInsufficient(blockLog),
      `the hold's reason is ${String(blockLog.reason)}`
    )
    Assert.ok(
      BigInt(blockLog.sysio_balance) < BigInt(blockLog.attempted_emission),
      `sysio could spend ${blockLog.sysio_balance}, enough for the attempted ${blockLog.attempted_emission}`
    )
    Assert.strictEqual(
      t5.last_epoch_index,
      blockLog.last_epoch_index,
      "t5state is from another tick"
    )
    Assert.strictEqual(
      BigInt(t5.pending_emission_amount),
      BigInt(blockLog.attempted_emission),
      "the held epochs did not accrue the period total the gate attempted"
    )
    Assert.strictEqual(
      t5.period_start_epoch,
      blockLog.epoch_index,
      "the held period does not begin at the first blocked economic epoch"
    )
    assertNothingPaidSince(epochLog, blockLog.epoch_index)
  }

  /** Assert no `epochlog` row was written at or after economic epoch `firstHeld`. */
  function assertNothingPaidSince(
    epochLog: readonly SysioContracts.SysioSystemEpochLogType[],
    firstHeld: number
  ): void {
    const paid = epochLog.filter(row => row.economic_epoch_index >= firstHeld)
    Assert.deepStrictEqual(
      paid.map(row => row.economic_epoch_index),
      [],
      `a held economic epoch paid: ${paid.map(row => row.economic_epoch_index).join(", ")}`
    )
  }

  /** READ every `sysio.msgch::envlog` row. */
  async function readEnvelopeLog<C extends ClusterBuildContext>(
    ctx: C
  ): Promise<SysioContracts.SysioMsgchEnvelopeLogEntryType[]> {
    return ctx.wire
      .getSysioContract(SysioContractName.msgch)
      .tables.envlog.queryAll()
  }

  /**
   * The highest `envlog` id.
   *
   * @param envelopeLog - The rows.
   * @returns The highest id; `0n` for an empty log.
   */
  export function envelopeLogTip(
    envelopeLog: readonly SysioContracts.SysioMsgchEnvelopeLogEntryType[]
  ): bigint {
    return envelopeLog.reduce(
      (tip, row) => (BigInt(row.id) > tip ? BigInt(row.id) : tip),
      0n
    )
  }

  /**
   * The consensus epoch of an envelope round trip with one outpost logged after `afterId`: the
   * depot's envelope out to it (`WIRE → outpost`) and its envelope back (`outpost → WIRE`) at the
   * same epoch, both admitted to `envlog` past the tip.
   *
   * @param envelopeLog - Every `envlog` row.
   * @param outpost - The outpost's chain kind.
   * @param afterId - The tip both rows must pass.
   * @returns The round trip's consensus epoch; absent when none completed.
   */
  export function findEnvelopeRoundTrip(
    envelopeLog: readonly SysioContracts.SysioMsgchEnvelopeLogEntryType[],
    outpost: SysioContracts.SysioMsgchChainkind,
    afterId: bigint
  ): number {
    const fresh = envelopeLog.filter(row => BigInt(row.id) > afterId),
      routed = (
        row: SysioContracts.SysioMsgchEnvelopeLogEntryType,
        start: SysioContracts.SysioMsgchChainkind,
        end: SysioContracts.SysioMsgchChainkind
      ): boolean =>
        matchesProtoEnum(
          row.endpoints.start.kind,
          SysioMsgchChainkind,
          start
        ) && matchesProtoEnum(row.endpoints.end.kind, SysioMsgchChainkind, end),
      outbound = fresh.filter(row =>
        routed(row, SysioMsgchChainkind.CHAIN_KIND_WIRE, outpost)
      ),
      inbound = fresh.filter(row =>
        routed(row, outpost, SysioMsgchChainkind.CHAIN_KIND_WIRE)
      )
    return outbound.find(out =>
      inbound.some(back => back.epoch_index === out.epoch_index)
    )?.epoch_index
  }

  /**
   * Poll until an envelope round trip with every outpost of
   * {@link EconomicClockScenarioConstants.OutpostChainKinds} has completed since the hold was
   * observed ({@link findEnvelopeRoundTrip}) — OPP keeps running while emissions are held. Pair it
   * with {@link EconomicClockScenarioConstants.RoundTripOptions}.
   */
  export function planAwaitEnvelopeRoundTrip<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    holdName: string
  ): ClusterBuildStep<C, HoldInput> {
    return ClusterBuildStep.create<C, HoldInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.HoldInput", holdName },
      runAwaitEnvelopeRoundTrip
    )
  }

  /** Named runner — poll `envlog` until every outpost completed a round trip past the hold's tip. */
  export async function runAwaitEnvelopeRoundTrip<
    C extends ClusterBuildContext
  >(ctx: C, input: HoldInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const { envelopeLogTip: tip } = ctx.outputs.assert(holdKey(input.holdName)),
      epochs = await pollFor(
        "an envelope round trip with every outpost while emissions are held",
        async () => {
          const envelopeLog = await readEnvelopeLog(ctx),
            found = Constants.OutpostChainKinds.map(outpost =>
              findEnvelopeRoundTrip(envelopeLog, outpost, tip)
            )
          return found.every(epoch => epoch != null) ? found : null
        },
        ProtocolTiming.SingleHopBudgetMs,
        WireEconomicClockTool.PollIntervalMs
      )
    Constants.OutpostChainKinds.forEach((outpost, index) =>
      log.info(
        `[economic-clock] ${SysioMsgchChainkind[outpost]} round trip completed at consensus epoch ${epochs[index]} while emissions are held`
      )
    )
  }

  /** Input of {@link planVerifyEmissionsHeldAcross}. */
  export interface HeldAcrossInput extends StepInput {
    readonly kind: "EconomicClockSteps.HeldAcrossInput"
    /** The hold ({@link holdKey}). */
    readonly holdName: string
    /** An observation of economic epochs that opened since ({@link WireEconomicClockTool.observationKey}). */
    readonly observationName: string
  }

  /**
   * Assert the hold persisted while both clocks ran on: the same episode covers every economic
   * epoch since it began, each still accruing, none paying, and consensus advanced unpaused
   * ({@link assertEmissionsHeldAcross}).
   */
  export function planVerifyEmissionsHeldAcross<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    holdName: string,
    observationName: string
  ): ClusterBuildStep<C, HeldAcrossInput> {
    return ClusterBuildStep.create<C, HeldAcrossInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.HeldAcrossInput", holdName, observationName },
      runVerifyEmissionsHeldAcross
    )
  }

  /** Named runner — read the ledger and `epochlog`, then assert. */
  export async function runVerifyEmissionsHeldAcross<
    C extends ClusterBuildContext
  >(ctx: C, input: HeldAcrossInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const ledger = await readEmissionsReading(ctx)
    Assert.ok(
      ledger != null,
      "an economic epoch opened mid-read; the ledger is inconsistent"
    )
    assertEmissionsHeldAcross(
      ctx.outputs.assert(holdKey(input.holdName)),
      ctx.outputs.assert(
        WireEconomicClockTool.observationKey(input.observationName)
      ),
      ledger,
      await Steps.contracts.sysio.system.readEpochLog(ctx),
      ctx.config.epochDurationSec
    )
  }

  /**
   * Assert a hold persisted across an observation: one open episode, the one first observed,
   * still `BALANCE_INSUFFICIENT` and covering every economic epoch from its first through the
   * latest the observation saw; the pending period total grew and equals what the gate now
   * attempts; no held epoch paid; and consensus advanced unpaused from the hold to the latest
   * reading (`WireEconomicClockTool.assertConsensusAdvanced`).
   *
   * @param hold - The hold as first observed.
   * @param observation - Economic epochs that opened since.
   * @param ledger - The emissions ledger now.
   * @param epochLog - Every `sysio::epochlog` row.
   * @param consensusEpochDurationSec - The cluster's consensus epoch duration (s).
   * @throws When the hold lapsed, an epoch paid, or either clock stood still.
   */
  export function assertEmissionsHeldAcross(
    hold: EconomicClockHoldSnapshot,
    observation: WireEconomicClockTool.Observation,
    ledger: EconomicClockEmissionsReading,
    epochLog: readonly SysioContracts.SysioSystemEpochLogType[],
    consensusEpochDurationSec: number
  ): void {
    const latest = WireEconomicClockTool.latestReading(observation)
    Assert.strictEqual(
      ledger.blockLog.length,
      1,
      "the emissions block episode closed"
    )
    const [blockLog] = ledger.blockLog
    Assert.strictEqual(
      blockLog.epoch_index,
      hold.blockLog.epoch_index,
      "another block episode replaced the observed hold"
    )
    Assert.ok(
      isBalanceInsufficient(blockLog),
      `the hold's reason is now ${String(blockLog.reason)}`
    )
    Assert.ok(
      latest.economicEpochIndex > hold.reading.economicEpochIndex,
      "the economic clock opened no epoch during the hold"
    )
    Assert.ok(
      blockLog.last_epoch_index >= latest.economicEpochIndex,
      `economic epoch ${latest.economicEpochIndex} opened without the gate holding it`
    )
    Assert.strictEqual(
      blockLog.blocked_epochs,
      blockLog.last_epoch_index - blockLog.epoch_index + 1,
      "an economic epoch inside the hold was not held"
    )
    Assert.strictEqual(
      BigInt(ledger.t5.pending_emission_amount),
      BigInt(blockLog.attempted_emission),
      "the held epochs did not accrue the period total the gate attempted"
    )
    Assert.ok(
      BigInt(ledger.t5.pending_emission_amount) >
        BigInt(hold.t5.pending_emission_amount),
      "the held period stopped accruing"
    )
    assertNothingPaidSince(epochLog, blockLog.epoch_index)
    WireEconomicClockTool.assertConsensusAdvanced(
      hold.reading,
      latest,
      consensusEpochDurationSec
    )
  }

  /** Input of {@link planAwaitEmissionsReleased} and {@link planVerifyEmissionsReleased}. */
  export interface ReleaseInput extends StepInput {
    readonly kind: "EconomicClockSteps.ReleaseInput"
    /** The hold ({@link holdKey}). */
    readonly holdName: string
    /** The release's name ({@link releaseKey}). */
    readonly releaseName: string
  }

  /**
   * Poll until an economic epoch pays the held period, recording the emissions ledger after
   * every tick it sees, and store the paying `epochlog` row with the ledger just before and just
   * after it ({@link releaseKey}). Place it right after the refund, which lands early in an
   * economic epoch, so the ledger after the last held epoch is still current when it starts. Pair
   * it with {@link emissionsWaitStepTimeoutMs}.
   */
  export function planAwaitEmissionsReleased<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    holdName: string,
    releaseName: string
  ): ClusterBuildStep<C, ReleaseInput> {
    return ClusterBuildStep.create<C, ReleaseInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.ReleaseInput", holdName, releaseName },
      runAwaitEmissionsReleased
    )
  }

  /** Named runner — poll the ledger and `epochlog` until the payout and both ledgers are in hand. */
  export async function runAwaitEmissionsReleased<
    C extends ClusterBuildContext
  >(ctx: C, input: ReleaseInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const hold = ctx.outputs.assert(holdKey(input.holdName)),
      ledgers = new Map<number, EconomicClockEmissionsReading>(),
      release = await pollFor(
        `an economic epoch pays the period held since economic epoch ${hold.blockLog.epoch_index}`,
        async () => {
          const ledger = await readEmissionsReading(ctx)
          if (ledger != null) ledgers.set(ledger.t5.last_epoch_index, ledger)
          const payout = (
            await Steps.contracts.sysio.system.readEpochLog(ctx)
          ).find(row => row.economic_epoch_index >= hold.blockLog.epoch_index)
          return payout == null ? null : releaseOf(payout, ledgers)
        },
        emissionsWaitDeadlineMs(ctx.config.economicEpochDurationSec),
        WireEconomicClockTool.PollIntervalMs
      )
    log.info(
      `[economic-clock] economic epoch ${release.payout.economic_epoch_index} paid the held period: ` +
        `${release.payout.total_emission}`
    )
    ctx.outputs.set(releaseKey(input.releaseName), release)
  }

  /**
   * The release snapshot of `payout`, from the ledgers recorded by economic epoch.
   *
   * @param payout - The paying `epochlog` row.
   * @param ledgers - The ledgers seen, keyed by `t5state.last_epoch_index`.
   * @returns The snapshot; absent while the ledger after the payout has not been read yet.
   * @throws When the ledger before or after the payout was missed — the next tick already passed.
   */
  export function releaseOf(
    payout: SysioContracts.SysioSystemEpochLogType,
    ledgers: ReadonlyMap<number, EconomicClockEmissionsReading>
  ): EconomicClockReleaseSnapshot {
    const paidEpoch = payout.economic_epoch_index,
      heldBefore = ledgers.get(paidEpoch - 1),
      paidAt = ledgers.get(paidEpoch),
      latestSeen = Math.max(...ledgers.keys())
    if (paidAt == null && latestSeen < paidEpoch) return null
    Assert.ok(
      heldBefore != null && paidAt != null,
      `the ledger around paying economic epoch ${paidEpoch} was not read before the next tick`
    )
    return { payout, heldBefore, paidAt }
  }

  /**
   * Assert the economic epoch that paid the held period paid all of it
   * ({@link assertEmissionsReleased}).
   */
  export function planVerifyEmissionsReleased<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    holdName: string,
    releaseName: string
  ): ClusterBuildStep<C, ReleaseInput> {
    return ClusterBuildStep.create<C, ReleaseInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.ReleaseInput", holdName, releaseName },
      runVerifyEmissionsReleased
    )
  }

  /** Named runner — assert the stored release against the stored hold. */
  export async function runVerifyEmissionsReleased<
    C extends ClusterBuildContext
  >(ctx: C, input: ReleaseInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    assertEmissionsReleased(
      ctx.outputs.assert(holdKey(input.holdName)),
      ctx.outputs.assert(releaseKey(input.releaseName))
    )
  }

  /**
   * Assert one economic epoch paid the whole held period and closed the episode: the epoch before
   * it was the last held one, of the same episode, which had held every epoch since the first;
   * the payout's total is everything accrued while held plus the paying epoch's own share; and
   * afterwards nothing is pending, no episode is open and the next period starts after it.
   *
   * @param hold - The hold as first observed.
   * @param release - The payout and the ledger around it.
   * @throws When the payout left part of the held period unpaid, or the episode open.
   */
  export function assertEmissionsReleased(
    hold: EconomicClockHoldSnapshot,
    release: EconomicClockReleaseSnapshot
  ): void {
    const { payout, heldBefore, paidAt } = release,
      paidEpoch = payout.economic_epoch_index,
      firstHeld = hold.blockLog.epoch_index
    Assert.strictEqual(
      heldBefore.blockLog.length,
      1,
      "no episode was open before the payout"
    )
    const [lastHeld] = heldBefore.blockLog
    Assert.strictEqual(
      lastHeld.epoch_index,
      firstHeld,
      "another episode was open before the payout"
    )
    Assert.strictEqual(
      lastHeld.last_epoch_index,
      paidEpoch - 1,
      "the payout is not the economic epoch after the last held one"
    )
    Assert.strictEqual(
      lastHeld.blocked_epochs,
      paidEpoch - firstHeld,
      "an economic epoch between the first held one and the payout was not held"
    )
    Assert.strictEqual(
      heldBefore.t5.period_start_epoch,
      firstHeld,
      "the paid period does not begin at the first held economic epoch"
    )
    Assert.strictEqual(
      BigInt(payout.total_emission),
      BigInt(heldBefore.t5.pending_emission_amount) +
        BigInt(paidAt.t5.last_epoch_emission),
      "the payout is not the held period's accrual plus the paying epoch's share"
    )
    Assert.ok(
      BigInt(payout.total_emission) > BigInt(hold.blockLog.attempted_emission),
      "the payout covers no more than the first held epoch"
    )
    Assert.deepStrictEqual(
      paidAt.blockLog,
      [],
      "the block episode is still open after the payout"
    )
    Assert.strictEqual(
      BigInt(paidAt.t5.pending_emission_amount),
      0n,
      "the payout left emission pending"
    )
    Assert.strictEqual(
      paidAt.t5.period_start_epoch,
      paidEpoch + 1,
      "the next pay period does not start after the payout"
    )
  }

  // ── Verify: the andon cord ───────────────────────────────────────────────

  /** Input of {@link planVerifyCord}. */
  export interface CordInput extends StepInput {
    readonly kind: "EconomicClockSteps.CordInput"
    /** Whether the cord must be pulled. */
    readonly pulled: boolean
  }

  /** Assert the `sysio.andon` cord is pulled, or clear. */
  export function planVerifyCord<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    pulled: boolean
  ): ClusterBuildStep<C, CordInput> {
    return ClusterBuildStep.create<C, CordInput>(
      actor,
      name,
      description,
      options,
      { kind: "EconomicClockSteps.CordInput", pulled },
      runVerifyCord
    )
  }

  /** Named runner — read the cord and compare. */
  export async function runVerifyCord<C extends ClusterBuildContext>(
    ctx: C,
    input: CordInput,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    const cord = await WireSyndicationTool.readCord(ctx)
    Assert.strictEqual(
      Boolean(cord?.pulled),
      input.pulled,
      `the andon cord is ${cord?.pulled ? "pulled" : "clear"}`
    )
  }
}
