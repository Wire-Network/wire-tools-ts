import Assert from "node:assert"

import { SysioContracts } from "@wireio/sdk-core"
import {
  assetUnits,
  ClusterBuildPhase,
  ProtocolTiming,
  Report,
  SolanaLiqSyndicationTool,
  Steps,
  SyndicationScenario,
  WireSyndicationTool,
  pollUntil,
  verifyStep,
  WireClient,
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

/** Whole seconds between two bucket ticks — the span tick_bucket refills by. */
function elapsedSeconds(
  previous: SysioContracts.SysioSyndBucketRowType,
  current: SysioContracts.SysioSyndBucketRowType
): bigint {
  return BigInt(
    (WireClient.chainTimeMs(current.last_refill) -
      WireClient.chainTimeMs(previous.last_refill)) /
      ProtocolTiming.MsPerSecond
  )
}

/** Verify tick_bucket's capped per-second refill, less this crank's release. */
function assertBucketRefill(
  previous: SysioContracts.SysioSyndBucketRowType,
  current: SysioContracts.SysioSyndBucketRowType,
  released: bigint
): void {
  const elapsed = elapsedSeconds(previous, current),
    refilled = BigInt(previous.level) + Constants.Refill * elapsed,
    capacity = refilled < Constants.Burst ? refilled : Constants.Burst
  Assert.ok(elapsed >= 0n, "bucket refill time must not regress")
  Assert.ok(released >= 0n && released <= capacity)
  Assert.strictEqual(BigInt(current.level), capacity - released)
}

/** Wait until the chain head is `seconds` past a bucket's last tick, so the next crank refills them. */
async function waitPastTick(
  ctx: ClusterBuildContext,
  bucket: SysioContracts.SysioSyndBucketRowType,
  seconds: number,
  timeoutMs: number
): Promise<void> {
  const target =
    WireClient.chainTimeMs(bucket.last_refill) +
    seconds * ProtocolTiming.MsPerSecond
  await pollUntil(
    `chain head ${seconds}s past the bucket's last tick`,
    async () =>
      WireClient.chainTimeMs((await ctx.wire.getInfo()).head_block_time) >=
      target,
    timeoutMs,
    SyndicationScenario.PollMs
  )
}

/** Arrival-ordered tranches, per-second lazy refill capped at the burst, and redemption refusal. */
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
    underwriterCount: 0
  }

  plan(cluster: ClusterBuild): void {
    this.planSetup(cluster, [Constants.UserA, Constants.UserB])
    ClusterBuildPhase.create(
      cluster,
      "BurstIntake",
      "Two sequential arrivals in one envelope total two bursts and one second of refill"
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
        "both ordered items share one request covering exactly the intake",
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
          Assert.strictEqual(BigInt(envelope.synd_total), Constants.Intake)
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
      "Release one full burst in arrival order"
    ).push(
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
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "Refill",
      "Release min(R x elapsed seconds, B) after the bucket lazily refills"
    ).push(
      verifyStep(
        Actor.Sysio,
        "wait-refill",
        "let at least one second pass since the first bucket tick",
        async ctx =>
          waitPastTick(
            ctx,
            ctx.outputs.assert(Constants.FirstBucket),
            1,
            ProtocolTiming.SingleHopBudgetMs
          ),
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
        "actual elapsed seconds determine the exact tranche and arrival-order balances",
        async ctx => {
          const bucket = await WireSyndicationTool.readBucket(
              ctx,
              SyndicationScenario.Chain,
              SyndicationScenario.Token,
              SysioSyndBucketDirection.SYNDICATION
            ),
            elapsed = elapsedSeconds(
              ctx.outputs.assert(Constants.FirstBucket),
              bucket
            ),
            available = elapsed * Constants.Refill,
            released =
              available < Constants.Burst ? available : Constants.Burst,
            toA = released < Constants.Overflow ? released : Constants.Overflow
          Assert.ok(elapsed > 0n)
          Assert.ok(
            Constants.Burst + released < Constants.Intake,
            "the refill crank must leave work for the final crank"
          )
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
        "wait long enough to refill a whole burst",
        async ctx =>
          waitPastTick(
            ctx,
            ctx.outputs.assert(Constants.RefillBucket),
            Constants.FullRefillSec,
            Constants.FullRefillBudgetMs
          ),
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
        "the final crank releases a positive tranche at a later bucket tick, completing both users",
        async ctx => {
          const previous = ctx.outputs.assert(Constants.RefillBucket),
            tranche =
              Constants.Intake - ctx.outputs.assert(Constants.RefillReleased)
          Assert.ok(
            tranche > 0n,
            "the final crank must release a positive tranche"
          )
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
            Constants.Intake
          )
          const bucket = await WireSyndicationTool.readBucket(
            ctx,
            SyndicationScenario.Chain,
            SyndicationScenario.Token,
            SysioSyndBucketDirection.SYNDICATION
          )
          Assert.ok(
            elapsedSeconds(previous, bucket) > 0n,
            "the final crank must advance the bucket's last refill"
          )
          assertBucketRefill(previous, bucket, tranche)
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
        "record balance, supply and outstanding returns",
        async ctx => {
          const { rows, more } = await ctx.wire
            .getSysioContract(SysioContractName.synd)
            .tables.returns.query({ limit: SyndicationScenario.QueryLimit })
          Assert.ok(!more)
          ctx.outputs.set(Constants.BeforeDesyndication, {
            balance: await SyndicationScenario.readBalance(
              ctx,
              Constants.UserA.account
            ),
            supply: assetUnits(
              (
                await WireSyndicationTool.readShadowStat(
                  ctx,
                  SyndicationScenario.Token
                )
              ).supply
            ),
            returns: rows.length
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
              .tables.returns.query({ limit: SyndicationScenario.QueryLimit })
          Assert.match(
            ctx.outputs.assert(Constants.Refusal),
            /desyndication exceeds the current budget/
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserA.account),
            before.balance
          )
          Assert.strictEqual(
            assetUnits(
              (
                await WireSyndicationTool.readShadowStat(
                  ctx,
                  SyndicationScenario.Token
                )
              ).supply
            ),
            before.supply
          )
          Assert.strictEqual(rows.length, before.returns)
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
        "exact debit, burn and outstanding return prove accepted queued redemption",
        async ctx => {
          const before = ctx.outputs.assert(Constants.BeforeDesyndication),
            { rows, more } = await ctx.wire
              .getSysioContract(SysioContractName.synd)
              .tables.returns.query({
                limit: SyndicationScenario.QueryLimit
              }),
            bucket = await WireSyndicationTool.readBucket(
              ctx,
              SyndicationScenario.Chain,
              SyndicationScenario.Token,
              SysioSyndBucketDirection.DESYNDICATION
            )
          Assert.ok(!more)
          Assert.strictEqual(rows.length, before.returns + 1)
          Assert.strictEqual(
            BigInt(rows[rows.length - 1].amount),
            Constants.DesyndicationNet
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserA.account),
            before.balance - Constants.DesyndicationAmount
          )
          Assert.strictEqual(
            assetUnits(
              (
                await WireSyndicationTool.readShadowStat(
                  ctx,
                  SyndicationScenario.Token
                )
              ).supply
            ),
            before.supply - Constants.DesyndicationNet
          )
          Assert.strictEqual(
            rows[rows.length - 1].holder,
            Constants.UserA.account
          )
          Assert.strictEqual(
            rows[rows.length - 1].token_code,
            SyndicationScenario.Token
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
                Constants.DesyndicationNet,
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
