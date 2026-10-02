import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  ProtocolTiming,
  Report,
  SolanaLiqSyndicationTool,
  Steps,
  SyndicationScenario,
  WireSyndicationTool,
  pollUntil,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { SyndicationRateLimitScenarioConstants as Constants } from "./SyndicationRateLimitScenarioConstants.js"
import { SyndicationRateLimitSteps } from "./steps/index.js"

const { Actor } = Report,
  { SysioSyndBucketDirection, SysioContractName } = SysioContracts

/** Wait for a new epoch so consecutive confirmed writes have a full epoch to execute. */
async function waitNewEpoch(ctx: ClusterBuildContext): Promise<void> {
  const before = await SyndicationScenario.readEpoch(ctx)
  await pollUntil(
    "next consensus epoch",
    async () => (await SyndicationScenario.readEpoch(ctx)) > before,
    ProtocolTiming.SingleHopBudgetMs,
    SyndicationScenario.PollMs
  )
}

/** Verify tick_bucket's capped refill, excluding frozen epochs, less this crank's release. */
function assertBucketRefill(
  previous: SysioContracts.SysioSyndBucketRowType,
  current: SysioContracts.SysioSyndBucketRowType,
  released: bigint
): void {
  const elapsed = BigInt(current.last_epoch - previous.last_epoch),
    frozenBefore = BigInt(previous.frozen_mark),
    frozenNow = BigInt(current.frozen_mark),
    frozenSince = frozenNow > frozenBefore ? frozenNow - frozenBefore : 0n,
    refillEpochs = elapsed > frozenSince ? elapsed - frozenSince : 0n,
    refilled = BigInt(previous.level) + Constants.Refill * refillEpochs,
    capacity = refilled < Constants.Burst ? refilled : Constants.Burst
  Assert.ok(elapsed >= 0n, "bucket epoch must not regress")
  Assert.strictEqual(frozenBefore, 0n, "this scenario has no frozen epochs")
  Assert.strictEqual(frozenNow, 0n, "this scenario has no frozen epochs")
  Assert.ok(released >= 0n && released <= capacity)
  Assert.strictEqual(BigInt(current.level), capacity - released)
}

/** Arrival-ordered tranches, same-epoch exhaustion, lazy refill and redemption refusal. */
export class SyndicationRateLimitScenario extends SyndicationScenario {
  readonly name = "flow-syndication-rate-limit"
  readonly description =
    "Two arrivals share a bonded envelope and release in exact bucket-limited tranches"
  override readonly defaults: ClusterBuildOptions = {
    enableMockSyndicationImport: true,
    enableMockLiqPools: true,
    epochDurationSec: SyndicationScenario.EpochDurationSec,
    producerCount: 3,
    batchOperatorCount: 3,
    underwriterCount: 1
  }

  plan(cluster: ClusterBuild): void {
    this.planSetup(cluster, [Constants.UserA, Constants.UserB])
    ClusterBuildPhase.create(
      cluster,
      "BurstIntake",
      "Two sequential arrivals in one envelope total twice the burst"
    ).push(
      Steps.contracts.sysio.synd.planSetconfig(
        Actor.Sysio,
        "configure-buckets",
        "set the scenario burst and refill",
        SyndicationScenario.WriteOptions,
        Constants.Config
      ),
      verifyStep(
        Actor.Sysio,
        "align-intake",
        "wait for the next epoch before both Solana writes",
        waitNewEpoch,
        SyndicationScenario.VerifyOptions
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "syndicate-a",
        "A arrives first",
        SyndicationScenario.OutpostOptions,
        Constants.UserA.keypairName,
        Constants.AmountA
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "syndicate-b",
        "B arrives second",
        SyndicationScenario.OutpostOptions,
        Constants.UserB.keypairName,
        Constants.AmountB
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "a-held",
        "verify held intake and its circulated custody attestation",
        SyndicationScenario.VerifyOptions,
        Constants.UserA,
        Constants.AmountA,
        Constants.Epoch,
        Constants.Request
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "b-held",
        "verify held intake and its circulated custody attestation",
        SyndicationScenario.VerifyOptions,
        Constants.UserB,
        Constants.AmountB,
        Constants.SecondEpoch,
        Constants.SecondRequest
      ),
      verifyStep(
        Actor.Sysio,
        "shared-envelope",
        "both ordered items share one request covering exactly 2B",
        async ctx => {
          Assert.strictEqual(
            ctx.outputs.assert(Constants.Epoch),
            ctx.outputs.assert(Constants.SecondEpoch)
          )
          Assert.strictEqual(
            ctx.outputs.assert(Constants.Request),
            ctx.outputs.assert(Constants.SecondRequest)
          )
          const envelope = await SyndicationScenario.readEnvelope(
              ctx,
              Constants.Epoch
            ),
            items = await WireSyndicationTool.readItems(
              ctx,
              SyndicationScenario.Chain,
              SyndicationScenario.Token,
              ctx.outputs.assert(Constants.Epoch)
            )
          Assert.strictEqual(BigInt(envelope.synd_total), Constants.Burst * 2n)
          Assert.strictEqual(items.length, 2)
          Assert.strictEqual(
            items[0].pubkey,
            SyndicationScenario.publicKey(ctx, Constants.UserA)
          )
          Assert.strictEqual(
            items[1].pubkey,
            SyndicationScenario.publicKey(ctx, Constants.UserB)
          )
          Assert.ok(BigInt(items[0].id) < BigInt(items[1].id))
        }
      )
    )
    WireSyndicationTool.planBondEnvelope(
      cluster,
      "BondBurst",
      "bond both arrivals together",
      SyndicationScenario.VerifyOptions,
      SyndicationScenario.Bonder,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      Constants.Epoch
    )
    ClusterBuildPhase.create(
      cluster,
      "InitialBurst",
      "Consume B in arrival order, then prove no same-epoch refill"
    ).push(
      verifyStep(
        Actor.Sysio,
        "align-cranks",
        "start the crank pair at a new epoch",
        waitNewEpoch,
        SyndicationScenario.VerifyOptions
      ),
      SyndicationScenario.planCrank(
        Actor.User,
        "first-crank",
        "advance the syndication queue",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.Sysio,
        "first-burst-exact",
        "A receives B, B receives zero, bucket is empty",
        async ctx => {
          const bucket = await WireSyndicationTool.readBucket(
            ctx,
            SyndicationScenario.Chain,
            SyndicationScenario.Token,
            SysioSyndBucketDirection.SYNDICATION
          )
          Assert.strictEqual(BigInt(bucket.level), 0n)
          Assert.strictEqual(
            BigInt(
              (await SyndicationScenario.readEnvelope(ctx, Constants.Epoch))
                .released
            ),
            Constants.Burst
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserA.account),
            Constants.Burst
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserB.account),
            0n
          )
          ctx.outputs.set(Constants.FirstBucket, bucket)
        }
      ),
      SyndicationScenario.planCrank(
        Actor.User,
        "same-epoch-crank",
        "advance the syndication queue",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.Sysio,
        "same-epoch-zero",
        "the repeat crank really ran in the same epoch and released zero",
        async ctx => {
          const bucket = await WireSyndicationTool.readBucket(
            ctx,
            SyndicationScenario.Chain,
            SyndicationScenario.Token,
            SysioSyndBucketDirection.SYNDICATION
          )
          Assert.strictEqual(
            bucket.last_epoch,
            ctx.outputs.assert(Constants.FirstBucket).last_epoch
          )
          Assert.strictEqual(
            await SyndicationScenario.readEpoch(ctx),
            ctx.outputs.assert(Constants.FirstBucket).last_epoch
          )
          Assert.strictEqual(BigInt(bucket.level), 0n)
          Assert.strictEqual(
            BigInt(
              (await SyndicationScenario.readEnvelope(ctx, Constants.Epoch))
                .released
            ),
            Constants.Burst
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserA.account),
            Constants.Burst
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserB.account),
            0n
          )
        }
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "Refill",
      "Release min(kR,B) after the bucket lazily refills"
    ).push(
      verifyStep(
        Actor.Sysio,
        "wait-refill",
        "advance beyond the first bucket epoch",
        async ctx => {
          await pollUntil(
            "refill epoch",
            async () =>
              (await SyndicationScenario.readEpoch(ctx)) >
              ctx.outputs.assert(Constants.FirstBucket).last_epoch,
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
        },
        SyndicationScenario.VerifyOptions
      ),
      SyndicationScenario.planCrank(
        Actor.User,
        "refill-crank",
        "advance the syndication queue",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.Sysio,
        "refill-exact",
        "actual elapsed epochs determine the exact tranche and arrival-order balances",
        async ctx => {
          const bucket = await WireSyndicationTool.readBucket(
              ctx,
              SyndicationScenario.Chain,
              SyndicationScenario.Token,
              SysioSyndBucketDirection.SYNDICATION
            ),
            elapsed = BigInt(
              bucket.last_epoch -
                ctx.outputs.assert(Constants.FirstBucket).last_epoch
            ),
            available = elapsed * Constants.Refill,
            released =
              available < Constants.Burst ? available : Constants.Burst,
            toA = released < Constants.Refill ? released : Constants.Refill
          Assert.ok(elapsed > 0n)
          Assert.strictEqual(
            BigInt(
              (await SyndicationScenario.readEnvelope(ctx, Constants.Epoch))
                .released
            ),
            Constants.Burst + released
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserA.account),
            Constants.Burst + toA
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserB.account),
            released - toA
          )
          assertBucketRefill(
            ctx.outputs.assert(Constants.FirstBucket),
            bucket,
            released
          )
          ctx.outputs.set(Constants.RefillBucket, bucket)
          ctx.outputs.set(Constants.RefillReleased, Constants.Burst + released)
        }
      ),
      verifyStep(
        Actor.Sysio,
        "wait-full-refill",
        "wait enough epochs to fill at most B",
        async ctx => {
          const epochs = Number(Constants.Burst / Constants.Refill)
          await pollUntil(
            "full refill",
            async () =>
              (await SyndicationScenario.readEpoch(ctx)) >=
              ctx.outputs.assert(Constants.RefillBucket).last_epoch + epochs,
            Constants.FullRefillBudgetMs,
            SyndicationScenario.PollMs
          )
        },
        {
          timeoutMs:
            Constants.FullRefillBudgetMs + ProtocolTiming.PollDeadlineBufferMs
        }
      ),
      SyndicationScenario.planCrank(
        Actor.User,
        "finish-burst",
        "advance the syndication queue",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.Sysio,
        "burst-drained",
        "both users have their full amounts and the bucket has its exact remaining capacity",
        async ctx => {
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserA.account),
            Constants.AmountA
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserB.account),
            Constants.AmountB
          )
          Assert.strictEqual(
            BigInt(
              (await SyndicationScenario.readEnvelope(ctx, Constants.Epoch))
                .released
            ),
            Constants.Burst * 2n
          )
          const bucket = await WireSyndicationTool.readBucket(
            ctx,
            SyndicationScenario.Chain,
            SyndicationScenario.Token,
            SysioSyndBucketDirection.SYNDICATION
          )
          assertBucketRefill(
            ctx.outputs.assert(Constants.RefillBucket),
            bucket,
            Constants.Burst * 2n - ctx.outputs.assert(Constants.RefillReleased)
          )
        }
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "DesyndicationBudget",
      "A redemption above budget is refused; one within it is queued"
    ).push(
      verifyStep(
        Actor.User,
        "snapshot-redemption",
        "record balance, supply, ledger and queued records",
        async ctx => {
          const { rows, more } = await ctx.wire
            .getSysioContract(SysioContractName.synd)
            .tables.desyndlog.query({ limit: SyndicationScenario.QueryLimit })
          Assert.ok(!more)
          ctx.outputs.set(Constants.BeforeDesyndication, {
            balance: await SyndicationScenario.readBalance(
              ctx,
              Constants.UserA.account
            ),
            supply: SyndicationScenario.units(
              (
                await WireSyndicationTool.readShadowStat(
                  ctx,
                  SyndicationScenario.Token
                )
              ).supply
            ),
            sum: BigInt(
              (
                await WireSyndicationTool.readLedger(
                  ctx,
                  SyndicationScenario.Chain,
                  SyndicationScenario.Token
                )
              ).desyndicated_sum
            ),
            logs: rows.length
          })
        }
      ),
      SyndicationRateLimitSteps.planRefusedDesyndication(
        Actor.User,
        "over-budget",
        "try to redeem more than a full bucket",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.User,
        "over-budget-refused",
        "budget refusal changed neither balance nor supply nor outbound queue",
        async ctx => {
          const before = ctx.outputs.assert(Constants.BeforeDesyndication),
            { rows } = await ctx.wire
              .getSysioContract(SysioContractName.synd)
              .tables.desyndlog.query({ limit: SyndicationScenario.QueryLimit })
          Assert.match(
            ctx.outputs.assert(Constants.Refusal),
            /desyndication exceeds the current budget/
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserA.account),
            before.balance
          )
          Assert.strictEqual(
            SyndicationScenario.units(
              (
                await WireSyndicationTool.readShadowStat(
                  ctx,
                  SyndicationScenario.Token
                )
              ).supply
            ),
            before.supply
          )
          Assert.strictEqual(rows.length, before.logs)
        }
      ),
      verifyStep(
        Actor.User,
        "snapshot-return-wallet",
        "record external balance before the accepted return",
        async ctx => {
          ctx.outputs.set(
            Constants.ExternalBalanceBefore,
            await SolanaLiqSyndicationTool.readLiqsolBalance(
              ctx,
              Constants.UserA.keypairName
            )
          )
        }
      ),
      Steps.contracts.sysio.synd.planDesyndicate(
        Actor.User,
        "within-budget",
        "redeem within the available level",
        SyndicationScenario.WriteOptions,
        {
          holder: Constants.UserA.account,
          quantity: SyndicationScenario.quantity(Constants.DesyndicationAmount)
        }
      ),
      verifyStep(
        Actor.User,
        "within-budget-queued",
        "exact debit, burn and desyndlog prove accepted queued redemption",
        async ctx => {
          const before = ctx.outputs.assert(Constants.BeforeDesyndication),
            { rows, more } = await ctx.wire
              .getSysioContract(SysioContractName.synd)
              .tables.desyndlog.query({
                limit: SyndicationScenario.QueryLimit
              }),
            bucket = await WireSyndicationTool.readBucket(
              ctx,
              SyndicationScenario.Chain,
              SyndicationScenario.Token,
              SysioSyndBucketDirection.DESYNDICATION
            )
          Assert.ok(!more)
          Assert.strictEqual(rows.length, before.logs + 1)
          Assert.strictEqual(
            BigInt(rows[rows.length - 1].amount),
            Constants.DesyndicationAmount
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserA.account),
            before.balance - Constants.DesyndicationAmount
          )
          Assert.strictEqual(
            SyndicationScenario.units(
              (
                await WireSyndicationTool.readShadowStat(
                  ctx,
                  SyndicationScenario.Token
                )
              ).supply
            ),
            before.supply - Constants.DesyndicationAmount
          )
          Assert.strictEqual(
            BigInt(
              (
                await WireSyndicationTool.readLedger(
                  ctx,
                  SyndicationScenario.Chain,
                  SyndicationScenario.Token
                )
              ).desyndicated_sum
            ),
            before.sum + Constants.DesyndicationAmount
          )
          Assert.strictEqual(
            BigInt(bucket.level),
            Constants.DesyndicationBurst - Constants.DesyndicationAmount
          )
        }
      )
    )
    WireSyndicationTool.planApproveAndClaim(
      cluster,
      "ApproveBurst",
      "approve and return the shared bond",
      SyndicationScenario.VerifyOptions,
      SyndicationScenario.Bonder,
      Constants.Request
    )
    ClusterBuildPhase.create(
      cluster,
      "VerifyExternalReturn",
      "Complete the accepted redemption at its destination"
    ).push(
      verifyStep(
        Actor.SolanaOutpost,
        "return-in-wallet",
        "the external wallet receives the exact desyndicated amount",
        async ctx => {
          await pollUntil(
            "external redemption settled",
            async () =>
              (await SolanaLiqSyndicationTool.readLiqsolBalance(
                ctx,
                Constants.UserA.keypairName
              )) ===
              ctx.outputs.assert(Constants.ExternalBalanceBefore) +
                Constants.DesyndicationAmount,
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
        },
        SyndicationScenario.VerifyOptions
      )
    )
    this.planFinish(cluster)
  }
}
