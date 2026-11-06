import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"
import {
  BatchOperatorUnderwritingSteps,
  OperatorDaemonTool,
  ProtocolTiming,
  StepExtraRecorder,
  SyndicationScenario,
  WireClient,
  WireSyndicationTool,
  matchesProtoEnum,
  pollFor,
  verifyStep,
  type ClusterBuildContext,
  type ClusterBuildStep,
  type ClusterBuildStepOptions,
  type Report
} from "@wireio/cluster-tool"

import { InitialHeld, type HeldObservation } from "../orchestration/index.js"

const { SysioBondRequestState } = SysioContracts

/**
 * The cap flow's own checks: for the whole life of the funded operator's first bond its
 * exposure cap is exhausted, so the second request stays issued but unbonded; it is bonded
 * only after the first bond is paid back, and the operator's LIQSOL is then exactly what it
 * was funded with, split between its liquid balance and that one new stake.
 */
export namespace SyndicationPluginUnderwritingCapSteps {
  /**
   * How long {@link planVerifySecondHeldByCap} watches for the first bond to be paid: the
   * challenge window it must outlive plus two plugin passes
   * (`OperatorDaemonTool.BatchEpochPollMs` each: one to approve, one to claim). The window
   * runs from the bond, which precedes the Step, so this bounds the wait from above.
   *
   * @param challengeWindowSec - The pair's `window_sec`.
   * @return The poll budget, in milliseconds.
   */
  export function heldBudgetMs(challengeWindowSec: number): number {
    return (
      challengeWindowSec * ProtocolTiming.MsPerSecond +
      2 * OperatorDaemonTool.BatchEpochPollMs
    )
  }

  /**
   * Step options for {@link planVerifySecondHeldByCap}: {@link heldBudgetMs} plus the poll
   * deadline margin.
   *
   * @param challengeWindowSec - The pair's `window_sec`.
   * @return The Step options.
   */
  export function heldOptions(
    challengeWindowSec: number
  ): ClusterBuildStepOptions {
    return {
      timeoutMs:
        heldBudgetMs(challengeWindowSec) + ProtocolTiming.PollDeadlineBufferMs
    }
  }

  /**
   * The one funded operator's account. The cap flow funds exactly one, so it is the only
   * possible bonder.
   *
   * @param ctx - The build context of an underwriting cluster.
   * @return The account.
   * @throws If the cluster funds any other number of operators.
   */
  export function fundedOperator(ctx: ClusterBuildContext): string {
    const funded = BatchOperatorUnderwritingSteps.fundedOperatorAccounts(ctx)
    Assert.strictEqual(
      funded.length,
      1,
      `the cap flow needs exactly one funded batch operator, the cluster funds ${funded.length}`
    )
    return funded[0]
  }

  /**
   * The funded operator's bond on `requestId`, or nothing.
   *
   * @param ctx - The build context.
   * @param requestId - The request.
   * @return The bond row.
   * @throws If the cluster does not fund exactly one operator.
   */
  export async function readFundedBond(
    ctx: ClusterBuildContext,
    requestId: SysioContracts.SysioBondApproveAction["request_id"]
  ): Promise<SysioContracts.SysioBondBondRowType> {
    const funded = fundedOperator(ctx)
    return (await WireSyndicationTool.readBonds(ctx, requestId)).find(
      bond => bond.underwriter === funded
    )
  }

  /**
   * Watch from before the second submission, discovering its request and capturing its
   * held state in that same poll iteration. Phase cancellation ends the poll on its next
   * iteration (at most one poll interval after any pending RPC completes).
   * No custody or finality wait separates request discovery from the observation. Payment
   * in the read bracket is accepted only with an OPEN, zero-bonded snapshot whose chain
   * creation time strictly precedes first approval; bonding is monotonic and atomic.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step ceiling above the issuance poll.
   * @param plan - The flow's typed outputs and syndication amounts.
   * @return The intake verification Step.
   */
  export function planVerifySecondRequested(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: BatchOperatorUnderwritingSteps.Plan
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async (ctx, signal) => {
        const firstId = ctx.outputs.assert(plan.firstRequest),
          floor = ctx.outputs.assert(plan.firstEpoch),
          envelope = await pollFor(
            `${name}: second request issued and held`,
            async () => {
              signal.throwIfAborted()
              const before = await readFundedBond(ctx, firstId)
              Assert.ok(
                before && !before.paid,
                "the first bond was paid or vanished before second intake showed a hold"
              )
              Assert.strictEqual(
                BigInt(before.amount),
                BatchOperatorUnderwritingSteps.maxExposure(ctx),
                "the first bond does not exhaust the cap"
              )
              const found = BatchOperatorUnderwritingSteps.findRecordedEnvelope(
                await WireSyndicationTool.readEnvelopes(
                  ctx,
                  SyndicationScenario.Chain,
                  SyndicationScenario.Token
                ),
                plan.laterAmount,
                floor
              )
              if (!found) return null
              const second = await WireSyndicationTool.readRequest(
                  ctx,
                  found.request_id
                ),
                heldAt = new Date().toISOString(),
                bonds = await WireSyndicationTool.readBonds(
                  ctx,
                  found.request_id
                ),
                after = await readFundedBond(ctx, firstId)
              Assert.ok(after, "the first bond vanished during second intake")
              signal.throwIfAborted()
              const first = after.paid
                ? await WireSyndicationTool.readRequest(ctx, firstId)
                : null
              if (after.paid) {
                // accept atomically creates its bond row and increases bonded. An OPEN,
                // zero-bonded request snapshot therefore had no bond at that reading,
                // even if the later bond-table RPC sees post-payment progress. Strict
                // chain-time ordering proves it was issued while the first was BONDED;
                // a request first issued after approval is never cap-hold evidence.
                Assert.ok(
                  second?.created_at &&
                    first?.resolved_at &&
                    WireClient.chainTimeMs(second.created_at) <
                      WireClient.chainTimeMs(first.resolved_at),
                  "payment raced intake without evidence of issuance before first approval"
                )
              }
              assertHeld(second, after.paid ? [] : bonds, 1)
              const observation = heldObservation(
                [heldAt],
                before,
                after.paid ? after : null,
                first
              )
              ctx.outputs.set(InitialHeld, observation)
              StepExtraRecorder.note("second request held at intake", {
                ...observation
              })
              return found
            },
            BatchOperatorUnderwritingSteps.UnderwriterRequestIssuedBudgetMs,
            SyndicationScenario.PollMs
          )
        ctx.outputs.set(plan.secondEpoch, envelope.epoch_index)
        ctx.outputs.set(plan.secondRequest, envelope.request_id)
      },
      options
    )
  }

  /**
   * The observation that ends {@link planVerifySecondHeldByCap}'s watch on a paid reading of
   * the first bond.
   *
   * @param held - Wall-clock times of the held readings, in order.
   * @param firstBond - The first bond as first read unpaid, or nothing.
   * @param paidBond - The first bond as read paid, or nothing for the initial held reading.
   * @param first - The first request's row at the paid reading.
   * @return The observation, stamped with the current wall-clock time.
   */
  export function heldObservation(
    held: readonly string[],
    firstBond: SysioContracts.SysioBondBondRowType,
    paidBond: SysioContracts.SysioBondBondRowType,
    first: SysioContracts.SysioBondRequestRowType
  ): HeldObservation {
    return {
      heldReadings: held.length,
      firstHeldAt: held[0] ?? null,
      lastHeldAt: held.at(-1) ?? null,
      firstBond,
      paidBond,
      paidAt: paidBond ? new Date().toISOString() : null,
      firstResolvedAt: first?.resolved_at ?? null
    }
  }

  /**
   * Assert one reading of the second request, taken while the first bond was unpaid, is
   * held: OPEN, nothing bonded and no bond row.
   *
   * @param second - The second request's row.
   * @param secondBonds - Its bond rows.
   * @param reading - The reading's ordinal, for the diagnostic.
   */
  export function assertHeld(
    second: SysioContracts.SysioBondRequestRowType,
    secondBonds: readonly SysioContracts.SysioBondBondRowType[],
    reading: number
  ): void {
    const at = `reading ${reading}, while the first bond is unpaid`
    Assert.ok(second, `${at}: the second request has no row`)
    Assert.ok(
      matchesProtoEnum(
        second.state,
        SysioBondRequestState,
        SysioBondRequestState.OPEN
      ),
      `${at}: the second request is ${String(second.state)}, not OPEN`
    )
    Assert.strictEqual(
      BigInt(second.bonded),
      0n,
      `${at}: the second request has ${String(second.bonded)} bonded`
    )
    Assert.deepStrictEqual(
      secondBonds,
      [],
      `${at}: the second request has bond rows`
    )
  }

  /**
   * Verify the exhausted cap holds the second request back for the whole life of the first
   * bond. Polls the funded operator's first bond until it reads `paid`; on EVERY reading
   * before that, the second request is read between two unpaid readings of the first bond
   * and must be OPEN with nothing bonded and no bond row. The first bond must equal the cap
   * (so with the second unbonded the operator's exposure is exactly its cap), at least one
   * held reading must exist, and the first bond row must not vanish before it is read paid.
   * The held-reading count and span, and the first request's `resolved_at` at the paid
   * reading, are recorded on the Report row, also when an assertion fails.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options; {@link heldOptions} of the pair's window.
   * @param plan - The flow's plan.
   * @param challengeWindowSec - The pair's `window_sec`, which sizes the poll.
   * @return The verify Step.
   */
  export function planVerifySecondHeldByCap(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: BatchOperatorUnderwritingSteps.Plan,
    challengeWindowSec: number
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const firstId = ctx.outputs.assert(plan.firstRequest),
          secondId = ctx.outputs.assert(plan.secondRequest),
          initial = ctx.outputs.get(InitialHeld),
          held: string[] = initial ? [initial.firstHeldAt] : []
        let firstBond: SysioContracts.SysioBondBondRowType = initial
            ? initial.firstBond
            : null,
          observation: HeldObservation = null
        const vanished = () =>
            `the first bond row vanished before it was read paid (after ${held.length} held readings)`,
          paid = async (paidBond: SysioContracts.SysioBondBondRowType) =>
            heldObservation(
              held,
              firstBond,
              paidBond,
              await WireSyndicationTool.readRequest(ctx, firstId)
            )
        try {
          observation = await pollFor(
            `${name}: the first bond is paid back`,
            async () => {
              const before = await readFundedBond(ctx, firstId)
              Assert.ok(before, vanished())
              if (before.paid) return paid(before)
              if (firstBond == null) {
                firstBond = before
                Assert.strictEqual(
                  BigInt(firstBond.amount),
                  BatchOperatorUnderwritingSteps.maxExposure(ctx),
                  "the first bond does not exhaust the cap"
                )
              }
              const second = await WireSyndicationTool.readRequest(
                  ctx,
                  secondId
                ),
                secondBonds = await WireSyndicationTool.readBonds(
                  ctx,
                  secondId
                ),
                after = await readFundedBond(ctx, firstId)
              Assert.ok(after, vanished())
              // Paid in between: the second request may already be bonding, so this
              // reading is not a held one.
              if (after.paid) return paid(after)
              assertHeld(second, secondBonds, held.length + 1)
              held.push(new Date().toISOString())
              return null
            },
            heldBudgetMs(challengeWindowSec),
            SyndicationScenario.PollMs
          )
        } finally {
          StepExtraRecorder.note(
            "second request held while the first bond was unpaid",
            {
              heldReadings: held.length,
              firstHeldAt: held[0] ?? null,
              lastHeldAt: held.at(-1) ?? null,
              heldSpanMs:
                held.length > 0
                  ? Date.parse(held.at(-1)) - Date.parse(held[0])
                  : 0,
              firstBond:
                firstBond == null
                  ? null
                  : { amount: String(firstBond.amount), paid: firstBond.paid },
              paidAt: observation?.paidAt ?? null,
              firstResolvedAt: observation?.firstResolvedAt ?? null
            }
          )
        }
        Assert.ok(
          observation.heldReadings > 0,
          "the first bond was paid before any reading showed the second request held"
        )
      },
      options
    )
  }

  /**
   * Verify the recovery: the first request is APPROVED and its bond paid, the funded
   * operator holds a bond on the second request, and its liquid LIQSOL plus any unpaid
   * stake is exactly its funded balance from setup (the pair's bounty is 0, so paying a bond
   * back returns the stake alone). Secondary to {@link planVerifySecondHeldByCap}, which
   * proves the hold: the second request's `bonded_at` is no earlier than the first
   * request's `resolved_at`.
   *
   * @param actor - Report actor.
   * @param name - Step name.
   * @param description - Step description.
   * @param options - Step options.
   * @param plan - The flow's plan.
   * @return The verify Step.
   */
  export function planVerifyBondedAfterRecovery(
    actor: Report.Actor,
    name: string,
    description: string,
    options: ClusterBuildStepOptions,
    plan: BatchOperatorUnderwritingSteps.Plan
  ): ClusterBuildStep {
    return verifyStep(
      actor,
      name,
      description,
      async ctx => {
        const firstId = ctx.outputs.assert(plan.firstRequest),
          secondId = ctx.outputs.assert(plan.secondRequest),
          before = ctx.outputs.assert(plan.before),
          first = await WireSyndicationTool.readRequest(ctx, firstId),
          second = await WireSyndicationTool.readRequest(ctx, secondId),
          firstBond = await readFundedBond(ctx, firstId),
          secondBond = await readFundedBond(ctx, secondId)
        let liquid =
          await BatchOperatorUnderwritingSteps.readOperatorsBalance(ctx)
        const secondBondAfter = await readFundedBond(ctx, secondId)
        Assert.ok(
          secondBond,
          `the funded operator holds no bond on request ${secondId}`
        )
        Assert.ok(
          secondBondAfter,
          `the bond on request ${secondId} vanished during the balance read`
        )
        Assert.strictEqual(
          secondBondAfter.amount,
          secondBond.amount,
          "the second bond amount changed during the balance read"
        )
        if (secondBond.paid !== secondBondAfter.paid) {
          Assert.ok(
            !secondBond.paid && secondBondAfter.paid,
            "the second bond payment regressed"
          )
          // Claim atomically credits the liquid balance and sets paid, which never reverts.
          // Re-read after that transition once; no sleep or progress poll is needed.
          liquid =
            await BatchOperatorUnderwritingSteps.readOperatorsBalance(ctx)
        }
        const secondStake = secondBondAfter.paid
          ? 0n
          : BigInt(secondBondAfter.amount)
        StepExtraRecorder.note("cap recovery ordering and balance", {
          firstResolvedAt: first?.resolved_at ?? null,
          secondBondedAt: second?.bonded_at ?? null,
          fundedBefore: String(before.operators),
          liquid: String(liquid),
          secondStake: String(secondStake),
          secondPaid: secondBondAfter.paid
        })
        Assert.ok(
          matchesProtoEnum(
            first?.state,
            SysioBondRequestState,
            SysioBondRequestState.APPROVED
          ),
          `request ${firstId} is ${String(first?.state)}, not APPROVED`
        )
        Assert.ok(firstBond?.paid, `the first bond is not paid back`)
        Assert.strictEqual(
          liquid + secondStake,
          before.operators,
          "the funded operator's liquid LIQSOL plus its stake on the second request is not its funded balance"
        )
        Assert.ok(
          WireClient.chainTimeMs(second.bonded_at) >=
            WireClient.chainTimeMs(first.resolved_at),
          `request ${second.id} was bonded at ${second.bonded_at}, before request ${first.id} was approved at ${first.resolved_at}`
        )
      },
      options
    )
  }
}
