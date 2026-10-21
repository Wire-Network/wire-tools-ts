import Assert from "node:assert"

import type { BatchOperatorUnderwritingConfig } from "@wireio/cluster-tool-shared"
import { AttestationType } from "@wireio/opp-typescript-models"
import { SlugName, SysioContracts } from "@wireio/sdk-core"
import { Constants, ProtocolTiming } from "../../Constants.js"
import {
  ClusterBuildStep,
  type ClusterBuildStepOptions
} from "../../orchestration/ClusterBuildStep.js"
import type { ClusterBuildContext } from "../../orchestration/ClusterBuildContext.js"
import { ClusterBuildPhase } from "../../orchestration/ClusterBuildPhase.js"
import type { ClusterBuildParent } from "../../orchestration/ClusterBuildPhaseBase.js"
import { outputKey, type OutputKey } from "../../orchestration/OutputStore.js"
import {
  pollFor,
  pollStep,
  pollUntil,
  verifyStep
} from "../../orchestration/StepTools.js"
import { Steps, SyndicationUserSteps } from "../../orchestration/steps/index.js"
import { Report } from "../../report/Report.js"
import { WireClient } from "../../clients/wire/WireClient.js"
import { SolanaLiqSyndicationTool } from "../../tools/solana/index.js"
import {
  OperatorDaemonTool,
  WireCollateralTool,
  WireSyndicationTool
} from "../../tools/wire/index.js"
import { eachSeries, mapSeries } from "../../utils/asyncUtils.js"
import { matchesProtoEnum } from "../../utils/predicateUtils.js"
import { SyndicationScenario } from "../SyndicationScenario.js"

const { SysioBondRequestState, SysioOpregOperatorstatus } = SysioContracts

/**
 * Report-visible checks of a flow whose batch operators underwrite on their own
 * (`enableBatchOperatorUnderwriting`): each one WAITS for an effect of the operators'
 * underwriter role it cannot take back — a bond, a full release, an approval, a claim — and
 * then asserts the exact accounting, so the timing of the operators' polls never decides the
 * verdict. A flow describes its syndications and recorded state with one {@link Plan}.
 */
export namespace BatchOperatorUnderwritingSteps {
  /** Exact accounting captured at the end of setup, before the first syndication. */
  export interface Snapshot {
    /** Shadow the `sysio.synd` holder row held. */
    readonly holder: bigint
    /** Liquid LIQSOL of the funded batch operators together — what they underwrite from. */
    readonly operators: bigint
    /** The fee pot. */
    readonly fees: bigint
  }

  /** A flow's syndications and the outputs its Steps record. */
  export interface Plan {
    /** The linked syndicator of the first and second syndications. */
    readonly user: SyndicationScenario.User
    /** The recipient linked only after release parks its shadow. */
    readonly unlinked: SyndicationScenario.User
    /** The first syndication's amount. */
    readonly amount: bigint
    /** The second syndication's amount; also the unlinked recipient's. */
    readonly laterAmount: bigint
    /** The pair's syndication fee rate. */
    readonly feeBps: number
    /** Balances at the end of setup. */
    readonly before: OutputKey<Snapshot>
    readonly firstEpoch: OutputKey<number>
    readonly firstRequest: WireSyndicationTool.RequestKey
    readonly secondEpoch: OutputKey<number>
    readonly secondRequest: WireSyndicationTool.RequestKey
    readonly parkedEpoch: OutputKey<number>
    readonly parkedRequest: WireSyndicationTool.RequestKey
  }

  /** The linked syndicator of a {@link createPlan} plan unless the flow names another. */
  export const DefaultUser: SyndicationScenario.User = {
    account: "synd.user",
    keypairName: "syndication-user",
    linked: true
  }
  /** The recipient a {@link createPlan} plan links only after release parks its shadow. */
  export const DefaultUnlinked: SyndicationScenario.User = {
    account: "synd.parked",
    keypairName: "syndication-parked",
    linked: false
  }
  /** First syndication amount: deliberately not an increment multiple, exercising covered rounding. */
  export const DefaultAmount = 2_000_000_001n
  /** Later syndication amount; also the unlinked recipient's. */
  export const DefaultLaterAmount = 500_000_000n
  /** A nonzero syndication fee rate, so every release nets a fee. */
  export const DefaultFeeBps = 100

  /** What a flow may set on {@link createPlan}; every member defaults. */
  export interface PlanOptions {
    /** Default {@link DefaultUser}. */
    readonly user?: SyndicationScenario.User
    /** Default {@link DefaultUnlinked}. */
    readonly unlinked?: SyndicationScenario.User
    /** Default {@link DefaultAmount}. */
    readonly amount?: bigint
    /** Default {@link DefaultLaterAmount}. */
    readonly laterAmount?: bigint
    /** Default {@link DefaultFeeBps}. */
    readonly feeBps?: number
  }

  /**
   * Build a flow's {@link Plan}, minting its seven output keys as `<keyPrefix>.<member>`
   * (`pluginUnderwriting.firstRequest`). Two flows must not share a prefix: their recorded
   * state would collide in one output store.
   *
   * @param keyPrefix - The flow's output-key namespace.
   * @param options - The syndications; every member defaults.
   * @return The plan.
   */
  export function createPlan(
    keyPrefix: string,
    {
      user = DefaultUser,
      unlinked = DefaultUnlinked,
      amount = DefaultAmount,
      laterAmount = DefaultLaterAmount,
      feeBps = DefaultFeeBps
    }: PlanOptions = {}
  ): Plan {
    const key = <T>(member: string, description: string) =>
      outputKey<T>(`${keyPrefix}.${member}`, description)
    return {
      user,
      unlinked,
      amount,
      laterAmount,
      feeBps,
      before: key<Snapshot>("before", "balances before the first syndication"),
      firstEpoch: key<number>("firstEpoch", "first consensus epoch"),
      firstRequest: key("firstRequest", "first request"),
      secondEpoch: key<number>("secondEpoch", "later consensus epoch"),
      secondRequest: key("secondRequest", "later request"),
      parkedEpoch: key<number>("parkedEpoch", "unlinked consensus epoch"),
      parkedRequest: key("parkedRequest", "unlinked request")
    }
  }

  /** Each rate-limit bucket's burst and refill in {@link configOf}: 100 tokens, far above a plan's syndications. */
  export const ConfigBucket = "100000000000"
  /** The extra stake a challenge costs in {@link configOf}: 1 token. */
  export const ConfigChallengeExtra = "1000000000"

  /**
   * The pair rules an underwriting flow sets in setup (and `planFinish` restores): the plan's
   * fee, buckets far above its syndications, no bounty and the given challenge window.
   *
   * @param plan - The flow's plan.
   * @param windowSec - The challenge window: how long each bond stays unpaid at least.
   * @return The `sysio.synd::setconfig` action.
   */
  export function configOf(
    plan: Plan,
    windowSec: number = ProtocolTiming.SyndicationChallengeWindowSec
  ): SysioContracts.SysioSyndSetconfigAction {
    return {
      chain_code: SyndicationScenario.Chain,
      token_code: SyndicationScenario.Token,
      synd_fee_bps: plan.feeBps,
      desynd_fee_bps: 0,
      synd_burst: ConfigBucket,
      synd_refill: ConfigBucket,
      desynd_burst: ConfigBucket,
      desynd_refill: ConfigBucket,
      window_sec: windowSec,
      bounty: 0,
      challenge_extra: ConfigChallengeExtra,
      min_desyndicate: Steps.registry.MinimumDesyndication
    }
  }

  /**
   * The net credit of a plan's later syndication: {@link Plan.laterAmount} less its fee.
   *
   * @param plan - The flow's plan.
   * @return The net base units the unlinked recipient is credited.
   */
  export function laterNetOf(plan: Plan): bigint {
    return (
      plan.laterAmount -
      SyndicationScenario.feeOf(plan.laterAmount, plan.feeBps)
    )
  }

  /**
   * Every request a plan records, in issue order.
   *
   * @param plan - The flow's plan.
   * @return Its request keys.
   */
  export function requestsOf(
    plan: Plan
  ): readonly WireSyndicationTool.RequestKey[] {
    return [plan.firstRequest, plan.secondRequest, plan.parkedRequest]
  }

  /**
   * Budget for each effect the operators' underwriter role produces once a request is in play
   * (a bond, a release, an approval after the challenge window, a claim): one depot hop. The
   * role cranks every poll while a request is in play, so none of these waits on the idle
   * crank. Polls return as soon as the effect is final.
   */
  export const DaemonEffectBudgetMs = ProtocolTiming.SingleHopBudgetMs
  /**
   * Budget for a syndication to reach the depot and get its request from the underwriter
   * role's crank: one hop plus the role's idle-crank spacing
   * (`OperatorDaemonTool.UnderwriterIdleCrankIntervalMs`), since only `sysio.synd::crank`
   * issues a request. Distinct from `WireSyndicationTool.RequestIssuedBudgetMs`, which assumes
   * a flow that cranks itself.
   */
  export const UnderwriterRequestIssuedBudgetMs =
    ProtocolTiming.SingleHopBudgetMs +
    OperatorDaemonTool.UnderwriterIdleCrankIntervalMs
  /**
   * Epochs of emitted outbound envelopes the Solana outpost keeps on chain, mirroring
   * `MAX_TRACKED_ENVELOPES` in wire-solana's `liqsol-core/src/states/opp_states.rs`. The
   * underwriter role verifies a request's statement against that log, so a request whose
   * epoch has left it can never be bonded.
   */
  export const SolanaRetainedEnvelopeEpochs = 10
  /**
   * The shortest whole-second epoch at which a request is still verifiable when it can only
   * be bonded once an earlier bond is paid back. The payback lands a challenge window
   * (one epoch plus `windowFixedSec`) plus `trailingSec` of plugin passes after that bond,
   * and the later request's statement is no older than it, so the window, the passes and
   * `headroomEpochs` must fit inside {@link SolanaRetainedEnvelopeEpochs} epochs. A longer
   * epoch only widens the margin: the log keeps a count of epochs, not a span of time.
   *
   * @param windowFixedSec - The challenge window less its one submission epoch (s).
   * @param trailingSec - Plugin passes between the window's end and the later bond (s).
   * @param headroomEpochs - Whole epochs the statement must still have in the log.
   * @return The epoch duration (s).
   */
  export function shortestRetainingEpochSec(
    windowFixedSec: number,
    trailingSec: number,
    headroomEpochs: number
  ): number {
    return Math.ceil(
      (windowFixedSec + trailingSec) / (SolanaRetainedEnvelopeEpochs - 1 - headroomEpochs)
    )
  }
  /** Step ceiling above {@link UnderwriterRequestIssuedBudgetMs}, by the poll deadline margin. */
  export const UnderwriterRequestIssuedOptions = {
    timeoutMs:
      UnderwriterRequestIssuedBudgetMs + ProtocolTiming.PollDeadlineBufferMs
  }
  /**
   * The on-chain accounts of the cluster's bootstrap batch operators, in label order.
   *
   * @param ctx - The build context (its key store holds the operators).
   * @return The accounts.
   */
  export function batchOperatorAccounts(ctx: ClusterBuildContext): string[] {
    return Constants.batchOperatorLabels(ctx.config.batchOperatorCount).map(
      label => ctx.keyStore.assertOperator(label).account
    )
  }

  /**
   * The bootstrap batch operators the mock import funded — the first
   * `batchOperatorUnderwriting.fundedOperatorCount` — whose accounts can bond.
   *
   * @param ctx - The build context of an underwriting cluster.
   * @return Their accounts, in label order.
   */
  export function fundedOperatorAccounts(ctx: ClusterBuildContext): string[] {
    const { fundedOperatorCount } = assertUnderwriting(ctx)
    return batchOperatorAccounts(ctx).slice(0, fundedOperatorCount)
  }

  /**
   * The bootstrap batch operators that run the underwriter role holding nothing.
   *
   * @param ctx - The build context of an underwriting cluster.
   * @return Their accounts, in label order.
   */
  export function unfundedOperatorAccounts(ctx: ClusterBuildContext): string[] {
    const { fundedOperatorCount } = assertUnderwriting(ctx)
    return batchOperatorAccounts(ctx).slice(fundedOperatorCount)
  }

  /** The cluster's underwriter-role configuration, refusing a relay-only cluster. */
  function assertUnderwriting(
    ctx: ClusterBuildContext
  ): BatchOperatorUnderwritingConfig {
    const underwriting = ctx.config.batchOperatorUnderwriting
    Assert.ok(
      underwriting != null,
      "the cluster's batch operators do not underwrite (batchOperatorUnderwriting is null)"
    )
    return underwriting
  }

  /**
   * Assert every unfunded batch operator still holds no LIQSOL: it runs the role but has
   * nothing to bond, so it never did.
   *
   * @param ctx - The build context of an underwriting cluster.
   */
  export async function assertUnfundedHoldNothing(
    ctx: ClusterBuildContext
  ): Promise<void> {
    await eachSeries(unfundedOperatorAccounts(ctx), async account =>
      Assert.strictEqual(
        await SyndicationScenario.readBalance(ctx, account),
        0n,
        `unfunded batch operator ${account} holds LIQSOL`
      )
    )
  }

  /**
   * The operators' exposure cap for one shadow, in base units, as their daemon args render it.
   *
   * @param ctx - The build context of an underwriting cluster.
   * @param token - The shadow codename; LIQSOL by default.
   * @return The cap.
   */
  export function maxExposure(
    ctx: ClusterBuildContext,
    token: string = SyndicationScenario.Token
  ): bigint {
    const cap = assertUnderwriting(ctx).maxExposure.find(
      amount => amount.tokenCode === BigInt(SlugName.from(token))
    )
    Assert.ok(cap, `no ${token} exposure cap is configured`)
    return cap.amount
  }

  /**
   * The funded batch operators' liquid LIQSOL together.
   *
   * @param ctx - The build context.
   * @return The sum in base units.
   */
  export async function readOperatorsBalance(
    ctx: ClusterBuildContext
  ): Promise<bigint> {
    return (
      await mapSeries(fundedOperatorAccounts(ctx), account =>
        SyndicationScenario.readBalance(ctx, account)
      )
    ).reduce((sum, balance) => sum + balance, 0n)
  }

  /**
   * Verify the setup left every funded batch operator with exactly its imported underwriting
   * credit, every unfunded one and the user with nothing, and record the balances the flow
   * settles against.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan.
   * @return The verify Step.
   */
  export function planVerifyOperatorsFunded(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: Plan
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const funded = fundedOperatorAccounts(ctx)
        Assert.ok(funded.length > 0, "the cluster funds no batch operator")
        await eachSeries(funded, async account =>
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, account),
            BigInt(Steps.registry.MockBatchOperatorUnderwritingPair.amount),
            `batch operator ${account} does not hold its underwriting credit`
          )
        )
        await assertUnfundedHoldNothing(ctx)
        Assert.strictEqual(
          await SyndicationScenario.readBalance(ctx, plan.user.account),
          0n
        )
        ctx.outputs.set(plan.before, {
          holder: await SyndicationScenario.readBalance(
            ctx,
            SysioContracts.SysioContractAccount.synd
          ),
          operators: await readOperatorsBalance(ctx),
          fees: await SyndicationScenario.readFees(ctx)
        })
      },
      options
    )
  }

  /**
   * Wait for a syndication of `amount` to reach the depot as an envelope with an issued
   * request (after the `after` epoch, when given), and record the envelope's epoch and
   * request. A held state is not required: the operators may bond and release it before the
   * first read. Only `sysio.synd::crank` issues a request, and while nothing is in play the
   * role cranks every {@link OperatorDaemonTool.UnderwriterIdleCrankIntervalMs}, hence the
   * budget. Its custody attestation is checked by the custody Steps, which wait for it.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options (above the request budget).
   * @param amount - The envelope's syndicated total.
   * @param after - The epoch the envelope must follow, or `null` for the first.
   * @param epoch - Where the envelope's epoch is recorded.
   * @param request - Where its request id is recorded.
   * @param chain - The outpost codename; SOLANA by default.
   * @param token - The shadow codename; LIQSOL by default.
   * @return The verify Step.
   */
  export function planVerifyRecorded(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    amount: bigint,
    after: OutputKey<number> | null,
    epoch: OutputKey<number>,
    request: WireSyndicationTool.RequestKey,
    chain: string = SyndicationScenario.Chain,
    token: string = SyndicationScenario.Token
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const floor = after == null ? -1 : ctx.outputs.assert(after),
          envelope = await pollFor(
            `${name}: the envelope has an issued request`,
            async () =>
              findRecordedEnvelope(
                await WireSyndicationTool.readEnvelopes(ctx, chain, token),
                amount,
                floor
              ),
            UnderwriterRequestIssuedBudgetMs,
            SyndicationScenario.PollMs
          )
        ctx.outputs.set(epoch, envelope.epoch_index)
        ctx.outputs.set(request, envelope.request_id)
      },
      options
    )
  }

  /**
   * The envelope a syndication of `amount` landed in: after the `floor` epoch, with exactly
   * that syndicated total and an issued request.
   *
   * @param envelopes - The pair's envelope rows.
   * @param amount - The syndicated total.
   * @param floor - The epoch the envelope must follow (-1 for none).
   * @return The envelope, or nothing yet.
   */
  export function findRecordedEnvelope(
    envelopes: readonly SysioContracts.SysioSyndEnvelopeRowType[],
    amount: bigint,
    floor: number
  ): SysioContracts.SysioSyndEnvelopeRowType {
    return envelopes.find(
      row =>
        row.epoch_index > floor &&
        BigInt(row.synd_total) === amount &&
        WireSyndicationTool.isRequestIssued(row)
    )
  }

  /** One consistent custody reading, taken once every custody attestation is persisted. */
  export interface CustodyObservation {
    /** The pool ATA's liqSOL balance. */
    readonly pool: bigint
    /** Every persisted custody attestation, ascending by sequence. */
    readonly attestations: readonly SyndicationScenario.CustodyAttestation[]
  }

  /**
   * Wait until the outpost has no yield claimed into the pool but unreported
   * (`yield_accumulated_liqsol == liq_yield_reported`) and the debugging artifacts hold the
   * attestation of its latest liq sequence, then read the pool between two identical
   * `GlobalState` readings. The newest attestation's `total_syndicated` then names the pool's
   * custody: a yield claim lands in the pool before any envelope carries its `LIQ_YIELD`, so
   * reading earlier compares the pool against a stale total.
   *
   * @param ctx - The build context.
   * @param label - What the poll is for (timeout message).
   * @return The observation.
   */
  export async function readSettledCustody(
    ctx: ClusterBuildContext,
    label: string
  ): Promise<CustodyObservation> {
    return pollFor(
      `${label}: every custody attestation is persisted and no yield is unreported`,
      async () => {
        const state = await SolanaLiqSyndicationTool.readLiqYieldState(ctx)
        if (state.yieldAccumulatedLiqsol !== state.liqYieldReported) return null
        const attestations =
          await SyndicationScenario.readCustodyAttestations(ctx)
        if (attestations.at(-1)?.sequence !== state.liqSequence) return null
        const pool = await SolanaLiqSyndicationTool.readPoolBalance(ctx),
          again = await SolanaLiqSyndicationTool.readLiqYieldState(ctx)
        return again.liqSequence === state.liqSequence &&
          again.liqYieldReported === state.liqYieldReported &&
          again.yieldAccumulatedLiqsol === state.yieldAccumulatedLiqsol
          ? { pool, attestations }
          : null
      },
      DaemonEffectBudgetMs,
      SyndicationScenario.PollMs
    )
  }

  /** Assert the pool equals the newest custody attestation's `total_syndicated`, exactly. */
  function assertCustodyExact({
    pool,
    attestations
  }: CustodyObservation): void {
    const latest = attestations.at(-1)
    Assert.strictEqual(
      pool,
      latest.totalSyndicated,
      `pool custody ${pool} differs from the total_syndicated ${latest.totalSyndicated} of attestation ${latest.sequence}`
    )
  }

  /**
   * `user`'s custody attestation of `amount`, among `attestations`, refusing one whose
   * `total_syndicated` is below its own syndication.
   */
  async function findUserAttestation(
    ctx: ClusterBuildContext,
    attestations: readonly SyndicationScenario.CustodyAttestation[],
    user: SyndicationScenario.User,
    amount: bigint
  ): Promise<SyndicationScenario.CustodyAttestation> {
    const decoded = await SyndicationScenario.readDecodedSyndications(
        ctx,
        user,
        amount
      ),
      found = attestations.find(attestation =>
        decoded.some(message => message.sequence === attestation.sequence)
      )
    Assert.ok(found, `no custody attestation of ${user.account}'s ${amount}`)
    Assert.ok(
      found.totalSyndicated >= amount,
      "custody attestation is below its own syndication"
    )
    return found
  }

  /** Assert `request`'s coverage is `amount` rounded up to the bond increment. */
  async function assertCovered(
    ctx: ClusterBuildContext,
    request: WireSyndicationTool.RequestKey,
    amount: bigint
  ): Promise<void> {
    Assert.strictEqual(
      BigInt(
        (
          await WireSyndicationTool.readRequest(
            ctx,
            ctx.outputs.assert(request)
          )
        ).covered
      ),
      SyndicationScenario.coveredOf(amount)
    )
  }

  /**
   * Verify the first request's coverage rounds up to the bond increment, its custody
   * attestation is persisted, and the pool equals the newest attested `total_syndicated`.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan.
   * @return The verify Step.
   */
  export function planVerifyFirstCoveredCustody(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: Plan
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        await assertCovered(ctx, plan.firstRequest, plan.amount)
        const observation = await readSettledCustody(ctx, name)
        await findUserAttestation(
          ctx,
          observation.attestations,
          plan.user,
          plan.amount
        )
        assertCustodyExact(observation)
      },
      options
    )
  }

  /**
   * Verify the second request's coverage, that the attested `total_syndicated` grew from the
   * first syndication to the second by exactly the second amount plus every `LIQ_YIELD` claim
   * between them, and that the pool equals the newest attested total.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan.
   * @return The verify Step.
   */
  export function planVerifySecondCoveredCustody(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: Plan
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        await assertCovered(ctx, plan.secondRequest, plan.laterAmount)
        const observation = await readSettledCustody(ctx, name),
          first = await findUserAttestation(
            ctx,
            observation.attestations,
            plan.user,
            plan.amount
          ),
          second = await findUserAttestation(
            ctx,
            observation.attestations,
            plan.user,
            plan.laterAmount
          ),
          yieldBetween = observation.attestations
            .filter(
              attestation =>
                attestation.type === AttestationType.LIQ_YIELD &&
                attestation.sequence > first.sequence &&
                attestation.sequence < second.sequence
            )
            .reduce((sum, attestation) => sum + attestation.amount, 0n)
        Assert.strictEqual(
          second.totalSyndicated - first.totalSyndicated,
          plan.laterAmount + yieldBetween,
          "the attested total did not grow by exactly the second syndication and the yield between"
        )
        assertCustodyExact(observation)
      },
      options
    )
  }

  /**
   * Verify the unlinked recipient's custody attestation is persisted and the pool equals the
   * newest attested `total_syndicated`.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan.
   * @return The verify Step.
   */
  export function planVerifyUnlinkedCustody(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: Plan
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const observation = await readSettledCustody(ctx, name)
        await findUserAttestation(
          ctx,
          observation.attestations,
          plan.unlinked,
          plan.laterAmount
        )
        assertCustodyExact(observation)
      },
      options
    )
  }

  /**
   * Wait until the operators bond `request` for its whole coverage, then assert every bond
   * row is a batch operator's, within the exposure cap, and together cover it, and that each
   * operator's unclaimed bonds stay within its cap. Runs right after the request is issued,
   * within the bond's challenge window, so no bond row can have been paid and pruned yet.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan.
   * @param request - The request to wait on.
   * @param token - The shadow whose configured exposure cap is enforced.
   * @return The verify Step.
   */
  export function planVerifyBonded(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: Plan,
    request: WireSyndicationTool.RequestKey,
    token: string = SyndicationScenario.Token
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const requestId = ctx.outputs.assert(request),
          row = await pollFor(
            `${name}: request ${requestId} is fully bonded`,
            async () => {
              const read = await WireSyndicationTool.readRequest(ctx, requestId)
              return WireSyndicationTool.isFullyBonded(read) ? read : null
            },
            DaemonEffectBudgetMs,
            SyndicationScenario.PollMs
          ),
          bonds = await WireSyndicationTool.readBonds(ctx, requestId),
          operators = fundedOperatorAccounts(ctx)
        Assert.ok(bonds.length > 0, `request ${requestId} has no bond row`)
        bonds.forEach(bond => {
          Assert.ok(
            operators.includes(bond.underwriter),
            `request ${requestId} is bonded by ${bond.underwriter}, not a funded batch operator`
          )
          Assert.ok(
            BigInt(bond.amount) <= maxExposure(ctx, token),
            `${bond.underwriter} bonded ${bond.amount}, above its ${maxExposure(ctx, token)} cap`
          )
        })
        Assert.strictEqual(
          bonds.reduce((sum, bond) => sum + BigInt(bond.amount), 0n),
          BigInt(row.covered)
        )
        await assertExposureWithinCap(ctx, plan, token)
      },
      options
    )
  }

  /**
   * The flow's request ids recorded so far.
   *
   * @param ctx - The build context.
   * @param plan - The flow's plan.
   * @return The ids, in issue order.
   */
  export function recordedRequests(
    ctx: ClusterBuildContext,
    plan: Plan
  ): SysioContracts.SysioBondApproveAction["request_id"][] {
    return requestsOf(plan)
      .map(key => ctx.outputs.get(key))
      .filter(id => id != null)
  }

  /**
   * Assert each operator's outstanding (unpaid) bonds across every request of the flow sum to
   * no more than the exposure cap the plugin enforces per underwriter and token.
   *
   * @param ctx - The build context.
   * @param plan - The flow's recorded requests for this token.
   * @param token - The shadow whose configured exposure cap is enforced.
   */
  export async function assertExposureWithinCap(
    ctx: ClusterBuildContext,
    plan: Plan,
    token: string = SyndicationScenario.Token
  ): Promise<void> {
    const unpaid = (
        await mapSeries(recordedRequests(ctx, plan), requestId =>
          WireSyndicationTool.readBonds(ctx, requestId)
        )
      )
        .flat()
        .filter(bond => !bond.paid),
      outstanding = unpaid.reduce(
        (sums, bond) =>
          sums.set(
            bond.underwriter,
            (sums.get(bond.underwriter) ?? 0n) + BigInt(bond.amount)
          ),
        new Map<string, bigint>()
      )
    outstanding.forEach((amount, underwriter) =>
      Assert.ok(
        amount <= maxExposure(ctx, token),
        `${underwriter} has ${amount} bonded and unclaimed, above its ${maxExposure(ctx, token)} cap`
      )
    )
  }

  /** One consistent read of the release accounting: the later envelope did not move during it. */
  export interface ReleaseObservation {
    readonly first: SysioContracts.SysioSyndEnvelopeRowType
    readonly second: SysioContracts.SysioSyndEnvelopeRowType
    readonly userBalance: bigint
    readonly fees: bigint
  }

  /**
   * Wait for the first envelope's full release, reading the user's balance and the fee pot
   * between two reads of the second envelope that agree on its `released` — the operators may
   * be releasing the second meanwhile.
   *
   * @param ctx - The build context.
   * @param label - What the poll is for (timeout message).
   * @param plan - The flow's plan.
   * @return The consistent observation.
   */
  export async function readFirstRelease(
    ctx: ClusterBuildContext,
    label: string,
    plan: Plan
  ): Promise<ReleaseObservation> {
    return pollFor(
      `${label}: the first envelope is released`,
      async () => {
        const first = await SyndicationScenario.readEnvelope(
          ctx,
          plan.firstEpoch
        )
        if (BigInt(first.released) !== plan.amount) return null
        const second = await SyndicationScenario.readEnvelope(
            ctx,
            plan.secondEpoch
          ),
          userBalance = await SyndicationScenario.readBalance(
            ctx,
            plan.user.account
          ),
          fees = await SyndicationScenario.readFees(ctx),
          again = await SyndicationScenario.readEnvelope(ctx, plan.secondEpoch)
        return BigInt(again.released) === BigInt(second.released)
          ? { first, second, userBalance, fees }
          : null
      },
      DaemonEffectBudgetMs,
      SyndicationScenario.PollMs
    )
  }

  /**
   * Verify the first release: exactly S released with its fee, the user credited S minus the
   * fee (plus the second envelope's net if it is released too), the fee pot up by the same
   * fees.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan.
   * @param expectedSecondRelease - What the second envelope must have released at that
   *   reading: `0n` for a flow that holds it back, or `null` (default) to accept nothing or
   *   all of it, for a flow whose operators may already have bonded it.
   * @return The verify Step.
   */
  export function planVerifyFirstRelease(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: Plan,
    expectedSecondRelease: bigint | null = null
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const { first, second, userBalance, fees } = await readFirstRelease(
            ctx,
            name,
            plan
          ),
          before = ctx.outputs.assert(plan.before),
          secondReleased = BigInt(second.released)
        if (expectedSecondRelease == null)
          Assert.ok(
            secondReleased === 0n || secondReleased === plan.laterAmount,
            `the second envelope released ${secondReleased}, neither nothing nor all of it`
          )
        else
          Assert.strictEqual(
            secondReleased,
            expectedSecondRelease,
            `the second envelope released ${secondReleased}, expected ${expectedSecondRelease}`
          )
        const firstFee = SyndicationScenario.feeOf(plan.amount, plan.feeBps),
          secondFee = SyndicationScenario.feeOf(secondReleased, plan.feeBps)
        Assert.strictEqual(BigInt(first.synd_total), plan.amount)
        Assert.strictEqual(BigInt(second.synd_total), plan.laterAmount)
        Assert.strictEqual(
          userBalance,
          plan.amount - firstFee + secondReleased - secondFee
        )
        Assert.strictEqual(fees, before.fees + firstFee + secondFee)
      },
      options
    )
  }

  /**
   * Wait for the second envelope to drain, then assert the user holds both nets and the fee
   * pot both fees — nothing else credits either once both envelopes are released.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan.
   * @return The verify Step.
   */
  export function planVerifySecondDrained(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: Plan
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        await pollUntil(
          `${name}: the second envelope is released`,
          async () =>
            BigInt(
              (await SyndicationScenario.readEnvelope(ctx, plan.secondEpoch))
                .released
            ) === plan.laterAmount,
          DaemonEffectBudgetMs,
          SyndicationScenario.PollMs
        )
        const before = ctx.outputs.assert(plan.before),
          firstFee = SyndicationScenario.feeOf(plan.amount, plan.feeBps),
          secondFee = SyndicationScenario.feeOf(plan.laterAmount, plan.feeBps)
        Assert.strictEqual(
          await SyndicationScenario.readBalance(ctx, plan.user.account),
          plan.amount - firstFee + plan.laterAmount - secondFee
        )
        Assert.strictEqual(
          await SyndicationScenario.readFees(ctx),
          before.fees + firstFee + secondFee
        )
      },
      options
    )
  }

  /**
   * Verify the queue order from the request rows: the later envelope is later, and its request
   * was issued no earlier than the first was bonded — the bond that released the first.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan.
   * @return The verify Step.
   */
  export function planVerifyQueueOrder(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: Plan
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const firstId = ctx.outputs.assert(plan.firstRequest),
          secondId = ctx.outputs.assert(plan.secondRequest),
          first = await WireSyndicationTool.readRequest(ctx, firstId),
          second = await WireSyndicationTool.readRequest(ctx, secondId)
        Assert.ok(
          ctx.outputs.assert(plan.secondEpoch) >
            ctx.outputs.assert(plan.firstEpoch)
        )
        Assert.ok(BigInt(secondId) > BigInt(firstId))
        Assert.ok(
          WireClient.chainTimeMs(second.created_at) >=
            WireClient.chainTimeMs(first.bonded_at),
          `request ${secondId} was issued at ${second.created_at}, before request ${firstId} was bonded at ${first.bonded_at}`
        )
      },
      options
    )
  }

  /**
   * Whether every bond on `requestId` is paid out (its row paid, or pruned once paid).
   *
   * @param ctx - The build context.
   * @param requestId - The request.
   * @return Whether no bond on it is unpaid.
   */
  export async function areBondsClaimed(
    ctx: ClusterBuildContext,
    requestId: SysioContracts.SysioBondApproveAction["request_id"]
  ): Promise<boolean> {
    return (await WireSyndicationTool.readBonds(ctx, requestId)).every(
      row => row.paid
    )
  }

  /**
   * Wait until the operators approve `request` and claim its bonds, then assert the approval
   * came no earlier than the challenge window allows, by chain time.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param request - The request to wait on.
   * @return The verify Step.
   */
  export function planVerifyApprovedAndClaimed(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    request: WireSyndicationTool.RequestKey
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const requestId = ctx.outputs.assert(request),
          row = await pollFor(
            `${name}: request ${requestId} is approved and its bonds claimed`,
            async () => {
              const read = await WireSyndicationTool.readRequest(ctx, requestId)
              return matchesProtoEnum(
                read?.state,
                SysioBondRequestState,
                SysioBondRequestState.APPROVED
              ) && (await areBondsClaimed(ctx, requestId))
                ? read
                : null
            },
            DaemonEffectBudgetMs,
            SyndicationScenario.PollMs
          )
        Assert.ok(
          WireClient.chainTimeMs(row.resolved_at) >=
            WireSyndicationTool.approveOpensAtMs(row),
          `request ${requestId} was approved at ${row.resolved_at}, inside its ${row.window_sec}s window from ${row.bonded_at}`
        )
      },
      options
    )
  }

  /**
   * Whether the unlinked recipient's envelope is fully released (into parked).
   *
   * @param ctx - The build context.
   * @param plan - The flow's plan.
   * @return Whether all of it is released.
   */
  export async function isParkedReleased(
    ctx: ClusterBuildContext,
    plan: Plan
  ): Promise<boolean> {
    return (
      BigInt(
        (await SyndicationScenario.readEnvelope(ctx, plan.parkedEpoch)).released
      ) === plan.laterAmount
    )
  }

  /**
   * Wait until the unlinked recipient's envelope is fully released (into parked).
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan.
   * @return The poll Step.
   */
  export function planVerifyParkedReleased(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: Plan
  ): ClusterBuildStep {
    return ClusterBuildStep.create(
      actor,
      name,
      description,
      options,
      null,
      pollStep.lift(
        `${name}: the unlinked recipient's envelope is released`,
        ctx => isParkedReleased(ctx, plan),
        DaemonEffectBudgetMs,
        SyndicationScenario.PollMs
      )
    )
  }

  /**
   * Exposure and custody accounting once every request is claimed and the parked credit is
   * delivered: no bond is unpaid, the operators' liquid LIQSOL together is back to exactly its
   * funded total (the scenario's bounty is zero), and the `sysio.synd` holder row is back to
   * its setup balance plus the fees it collected — fees are the only shadow it keeps, since
   * every item is released and the parked credit swept.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan (its requests' bonds must be paid).
   * @return The verify Step.
   */
  export function planVerifySettled(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: Plan
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        await eachSeries([...requestsOf(plan)], async key => {
          const requestId = ctx.outputs.assert(key)
          Assert.ok(
            await areBondsClaimed(ctx, requestId),
            `a bond on request ${requestId} is unpaid`
          )
        })
        const before = ctx.outputs.assert(plan.before)
        Assert.strictEqual(await readOperatorsBalance(ctx), before.operators)
        await assertUnfundedHoldNothing(ctx)
        Assert.strictEqual(
          (await SyndicationScenario.readBalance(
            ctx,
            SysioContracts.SysioContractAccount.synd
          )) - before.holder,
          (await SyndicationScenario.readFees(ctx)) - before.fees,
          "the sysio.synd holder kept shadow beyond the fees it collected"
        )
      },
      options
    )
  }

  /**
   * Verify underwriting left every batch operator ACTIVE: the relay role kept working.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @return The verify Step.
   */
  export function planVerifyOperatorsActive(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        await eachSeries(
          Constants.batchOperatorLabels(ctx.config.batchOperatorCount),
          async label => {
            const row = await WireCollateralTool.readOperatorRow(ctx, label)
            Assert.ok(row, `batch operator ${label} has no sysio.opreg row`)
            Assert.ok(
              matchesProtoEnum(
                row.status,
                SysioOpregOperatorstatus,
                SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
              ),
              `batch operator ${label} is ${String(row.status)}, not ACTIVE`
            )
          }
        )
      },
      options
    )
  }

  /** The flow-specific wording of {@link planConfigureUnderwriting}'s phase and Steps. */
  export interface ConfigureUnderwritingWording {
    /** The phase description. */
    readonly phase: string
    /** The `configure-underwriting` Step description. */
    readonly configure: string
    /** The `operators-funded` Step description. */
    readonly funded: string
  }

  /**
   * Phase `ConfigureUnderwriting`: set the pair rules, then verify which batch operators hold
   * their underwriting credit and record the balances the flow settles against.
   *
   * @param parent - The build root or an enclosing group.
   * @param plan - The flow's plan.
   * @param config - The pair rules ({@link configOf}).
   * @param wording - The phase and Step descriptions.
   * @return The self-registered phase.
   */
  export function planConfigureUnderwriting<
    C extends ClusterBuildContext = ClusterBuildContext
  >(
    parent: ClusterBuildParent<C>,
    plan: Plan,
    config: SysioContracts.SysioSyndSetconfigAction,
    wording: ConfigureUnderwritingWording
  ): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(
      parent,
      "ConfigureUnderwriting",
      wording.phase
    ).push(
      Steps.contracts.sysio.synd.planSetconfig(
        Report.Actor.Sysio,
        "configure-underwriting",
        wording.configure,
        SyndicationScenario.WriteOptions,
        config
      ),
      planVerifyOperatorsFunded(
        Report.Actor.Underwriter,
        "operators-funded",
        wording.funded,
        {},
        plan
      )
    )
  }

  /**
   * Phase `UnlinkedIntake`: the unlinked recipient syndicates, and the operators issue,
   * bond and release its request into parked credit. Planned after the second request is
   * recorded (its epoch bounds the search).
   *
   * @param parent - The build root or an enclosing group.
   * @param plan - The flow's plan.
   * @return The self-registered phase.
   */
  export function planUnlinkedIntake<
    C extends ClusterBuildContext = ClusterBuildContext
  >(parent: ClusterBuildParent<C>, plan: Plan): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(
      parent,
      "UnlinkedIntake",
      "An unlinked recipient syndicates; the funded operators bond and release it into parked"
    ).push(
      SolanaLiqSyndicationTool.planSynd(
        Report.Actor.User,
        "unlinked-syndication",
        "syndicate before linking",
        SyndicationScenario.OutpostOptions,
        plan.unlinked.keypairName,
        plan.laterAmount
      ),
      planVerifyRecorded(
        Report.Actor.Sysio,
        "unlinked-requested",
        "its envelope has an issued request",
        UnderwriterRequestIssuedOptions,
        plan.laterAmount,
        plan.secondEpoch,
        plan.parkedEpoch,
        plan.parkedRequest
      ),
      planVerifyBonded(
        Report.Actor.Underwriter,
        "unlinked-bonded",
        "the funded operators bond the unlinked recipient's request within their caps",
        SyndicationScenario.VerifyOptions,
        plan,
        plan.parkedRequest
      ),
      planVerifyUnlinkedCustody(
        Report.Actor.Sysio,
        "unlinked-custody",
        "its attestation is persisted and the newest total_syndicated equals custody",
        SyndicationScenario.VerifyOptions,
        plan
      ),
      planVerifyParkedReleased(
        Report.Actor.Sysio,
        "unlinked-released",
        "the operators' crank releases the unlinked envelope",
        SyndicationScenario.VerifyOptions,
        plan
      )
    )
  }

  /**
   * Phase `ParkAndLink`: the unlinked recipient's net credit is parked, and its own
   * `createlink` delivers it exactly once.
   *
   * @param parent - The build root or an enclosing group.
   * @param plan - The flow's plan.
   * @return The self-registered phase.
   */
  export function planParkAndLink<
    C extends ClusterBuildContext = ClusterBuildContext
  >(parent: ClusterBuildParent<C>, plan: Plan): ClusterBuildPhase<C> {
    const { account, keypairName } = plan.unlinked,
      net = laterNetOf(plan)
    return ClusterBuildPhase.create<C>(
      parent,
      "ParkAndLink",
      "Parked credit is delivered by the recipient's own createlink"
    ).push(
      SyndicationUserSteps.planVerifyParkedCredit(
        Report.Actor.User,
        "parked-credit",
        "the net credit is parked and the account has zero",
        {},
        account,
        keypairName,
        SyndicationScenario.Token,
        net
      ),
      SyndicationUserSteps.planLinkSolanaKey(
        Report.Actor.User,
        "link-recipient",
        "createlink delivers the parked credit",
        SyndicationScenario.WriteOptions,
        account,
        keypairName
      ),
      SyndicationUserSteps.planVerifyParkedDelivered(
        Report.Actor.User,
        "parked-delivered",
        "the exact net balance reached the linked account once",
        {},
        account,
        keypairName,
        SyndicationScenario.Token,
        net
      )
    )
  }

  /**
   * Phase `Settle`: the operators approve and claim the unlinked request, every bond of the
   * plan is paid back, the funded operators hold their credit again, the unfunded ones
   * nothing, the holder only fees — and every operator is still ACTIVE.
   *
   * @param parent - The build root or an enclosing group.
   * @param plan - The flow's plan.
   * @return The self-registered phase.
   */
  export function planSettle<
    C extends ClusterBuildContext = ClusterBuildContext
  >(parent: ClusterBuildParent<C>, plan: Plan): ClusterBuildPhase<C> {
    return ClusterBuildPhase.create<C>(
      parent,
      "Settle",
      "The operators approve and claim the parked recipient's request; exposure settles"
    ).push(
      planVerifyApprovedAndClaimed(
        Report.Actor.Underwriter,
        "unlinked-approved-and-claimed",
        "unlinked request APPROVED after its window and its bonds paid back",
        SyndicationScenario.VerifyOptions,
        plan.parkedRequest
      ),
      planVerifySettled(
        Report.Actor.Underwriter,
        "operators-settled",
        "no unpaid bond remains, the funded operators' LIQSOL is back to its funded total, the unfunded hold nothing and the holder keeps only fees",
        {},
        plan
      ),
      planVerifyOperatorsActive(
        Report.Actor.BatchOperator,
        "operators-active",
        "every batch operator is still ACTIVE: underwriting did not disturb the relay",
        {}
      )
    )
  }
}
