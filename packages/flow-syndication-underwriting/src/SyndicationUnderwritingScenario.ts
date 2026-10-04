import Assert from "node:assert"

import { oppDebuggingPath } from "@wireio/debugging-shared"
import {
  AttestationType,
  DebugOutpostEndpointsType,
  SyndicateLIQ
} from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  Report,
  ProtocolTiming,
  SolanaLiqSyndicationTool,
  Steps,
  SyndicationScenario,
  SyndicationUserSteps,
  WireSyndicationTool,
  matchesProtoEnum,
  readEnvelopeAttestations,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { SyndicationUnderwritingScenarioConstants as Constants } from "./SyndicationUnderwritingScenarioConstants.js"

import { SyndicationUnderwritingSteps } from "./steps/index.js"

const { Actor } = Report,
  { SysioSyndEnvelopeState, SysioSyndChainkind } = SysioContracts

/** Prove held intake, serialized requests, fee-bearing release, approval and linked delivery. */
export class SyndicationUnderwritingScenario extends SyndicationScenario {
  readonly name = "flow-syndication-underwriting"
  readonly description =
    "Held syndications are bonded, released with fees, approved and claimed; parked credit is linked"
  override readonly defaults: ClusterBuildOptions = {
    enableMockSyndicationImport: true,
    enableMockLiqPools: true,
    epochDurationSec: SyndicationScenario.EpochDurationSec,
    producerCount: 3,
    batchOperatorCount: 3,
    underwriterCount: 1
  }

  plan(cluster: ClusterBuild): void {
    this.planSetup(cluster, [Constants.User, Constants.Unlinked])
    ClusterBuildPhase.create(
      cluster,
      "FirstIntake",
      "Hold the linked user's syndication before any bond"
    ).push(
      Steps.contracts.sysio.synd.planSetconfig(
        Actor.Sysio,
        "configure-underwriting",
        "enable the scenario fee and buckets",
        SyndicationScenario.WriteOptions,
        Constants.Config
      ),
      verifyStep(
        Actor.Sysio,
        "snapshot-before",
        "record custody, bonder and fee balances",
        async ctx => {
          ctx.outputs.set(Constants.Before, {
            holder: await SyndicationScenario.readBalance(
              ctx,
              SysioContracts.SysioContractAccount.synd
            ),
            bonder: await SyndicationScenario.readBalance(
              ctx,
              SyndicationScenario.Bonder
            ),
            fees: await SyndicationScenario.readFees(ctx)
          })
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.User.account),
            0n
          )
        }
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "first-syndication",
        "syndicate the non-rounded amount",
        SyndicationScenario.OutpostOptions,
        Constants.User.keypairName,
        Constants.Amount
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "first-intake-held",
        "verify held intake and its circulated custody attestation",
        SyndicationScenario.VerifyOptions,
        Constants.User,
        Constants.Amount,
        Constants.FirstEpoch,
        Constants.FirstRequest
      ),
      verifyStep(
        Actor.Sysio,
        "requested-covered-custody",
        "REQUESTED holds S, user has zero, coverage rounds up and total_syndicated equals custody",
        async ctx => {
          const envelope = await SyndicationScenario.readEnvelope(
              ctx,
              Constants.FirstEpoch
            ),
            request = await WireSyndicationTool.readRequest(
              ctx,
              envelope.request_id
            ),
            before = ctx.outputs.assert(Constants.Before),
            messages = (
              await readEnvelopeAttestations(
                oppDebuggingPath(ctx.config.clusterPath),
                DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
                AttestationType.SYNDICATE_LIQ
              )
            ).map(bytes => SyndicateLIQ.fromBinary(bytes)),
            message = messages.find(
              value =>
                value.amount?.amount === Constants.Amount &&
                Buffer.from(value.user?.address).toString("hex") ===
                  SyndicationScenario.publicKey(ctx, Constants.User)
            )
          Assert.ok(
            matchesProtoEnum(
              envelope.state,
              SysioSyndEnvelopeState,
              SysioSyndEnvelopeState.REQUESTED
            )
          )
          Assert.strictEqual(
            BigInt(request.covered),
            ((Constants.Amount + SyndicationScenario.Increment - 1n) /
              SyndicationScenario.Increment) *
              SyndicationScenario.Increment
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(
              ctx,
              SysioContracts.SysioContractAccount.synd
            ),
            before.holder + Constants.Amount
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.User.account),
            0n
          )
          Assert.strictEqual(
            message.totalSyndicated,
            await SolanaLiqSyndicationTool.readPoolBalance(ctx)
          )
        }
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "LaterIntake",
      "A later envelope waits behind the unbonded request"
    ).push(
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "second-syndication",
        "syndicate after the first envelope closed",
        SyndicationScenario.OutpostOptions,
        Constants.User.keypairName,
        Constants.LaterAmount
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "later-intake-held",
        "verify held intake and its circulated custody attestation",
        SyndicationScenario.VerifyOptions,
        Constants.User,
        Constants.LaterAmount,
        Constants.SecondEpoch,
        Constants.SecondRequest
      ),
      verifyStep(
        Actor.Sysio,
        "later-waits",
        "the later epoch has no issued request",
        async ctx => {
          const envelope = await SyndicationScenario.readEnvelope(
            ctx,
            Constants.SecondEpoch
          )
          Assert.ok(
            envelope.epoch_index > ctx.outputs.assert(Constants.FirstEpoch)
          )
          Assert.ok(
            matchesProtoEnum(
              envelope.state,
              SysioSyndEnvelopeState,
              SysioSyndEnvelopeState.WAITING
            )
          )
          Assert.ok(!WireSyndicationTool.isRequestIssued(envelope))
        }
      )
    )
    WireSyndicationTool.planBondEnvelope(
      cluster,
      "BondFirst",
      "bond the first request's remainder",
      SyndicationScenario.VerifyOptions,
      SyndicationScenario.Bonder,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      Constants.FirstEpoch
    )
    ClusterBuildPhase.create(
      cluster,
      "ReleaseFirst",
      "Release S minus the fee and issue the next request"
    ).push(
      SyndicationScenario.planCrank(
        Actor.User,
        "release-first",
        "advance the syndication queue",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.Sysio,
        "first-released-next-requested",
        "exact fee and linked credit; second request is now issued",
        async ctx => {
          const before = ctx.outputs.assert(Constants.Before),
            fee =
              (Constants.Amount * BigInt(Constants.FeeBps)) /
              SyndicationScenario.BasisPoints,
            first = await SyndicationScenario.readEnvelope(
              ctx,
              Constants.FirstEpoch
            ),
            second = await SyndicationScenario.readEnvelope(
              ctx,
              Constants.SecondEpoch
            )
          Assert.strictEqual(BigInt(first.released), Constants.Amount)
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.User.account),
            Constants.Amount - fee
          )
          Assert.strictEqual(
            await SyndicationScenario.readFees(ctx),
            before.fees + fee
          )
          Assert.strictEqual(BigInt(first.synd_total), Constants.Amount)
          Assert.strictEqual(BigInt(second.synd_total), Constants.LaterAmount)
          Assert.ok(
            matchesProtoEnum(
              second.state,
              SysioSyndEnvelopeState,
              SysioSyndEnvelopeState.REQUESTED
            )
          )
          ctx.outputs.set(Constants.SecondRequest, second.request_id)
        }
      )
    )
    WireSyndicationTool.planApproveAndClaim(
      cluster,
      "ApproveFirst",
      "wait for the challenge window, approve and return the bond",
      SyndicationScenario.VerifyOptions,
      SyndicationScenario.Bonder,
      Constants.FirstRequest
    )
    ClusterBuildPhase.create(
      cluster,
      "VerifyFirstClaim",
      "The bonder recovers its full stake"
    ).push(
      SyndicationUnderwritingSteps.planVerifyClaim(
        Actor.Underwriter,
        "approved-and-returned",
        "request APPROVED and bond balance restored",
        {}
      )
    )
    WireSyndicationTool.planBondEnvelope(
      cluster,
      "BondSecond",
      "bond the newly issued request",
      SyndicationScenario.VerifyOptions,
      SyndicationScenario.Bonder,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      Constants.SecondEpoch
    )
    ClusterBuildPhase.create(
      cluster,
      "ReleaseSecond",
      "Drain the second envelope"
    ).push(
      SyndicationScenario.planCrank(
        Actor.User,
        "release-second",
        "advance the syndication queue",
        SyndicationScenario.WriteOptions
      )
    )
    WireSyndicationTool.planApproveAndClaim(
      cluster,
      "ApproveSecond",
      "approve and claim the second request",
      SyndicationScenario.VerifyOptions,
      SyndicationScenario.Bonder,
      Constants.SecondRequest
    )
    ClusterBuildPhase.create(
      cluster,
      "UnlinkedIntake",
      "An unlinked recipient syndicates"
    ).push(
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "unlinked-syndication",
        "syndicate before linking",
        SyndicationScenario.OutpostOptions,
        Constants.Unlinked.keypairName,
        Constants.LaterAmount
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "unlinked-held",
        "verify held intake and its circulated custody attestation",
        SyndicationScenario.VerifyOptions,
        Constants.Unlinked,
        Constants.LaterAmount,
        Constants.ParkedEpoch,
        Constants.ParkedRequest
      )
    )
    WireSyndicationTool.planBondEnvelope(
      cluster,
      "BondUnlinked",
      "bond the unlinked recipient's request",
      SyndicationScenario.VerifyOptions,
      SyndicationScenario.Bonder,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      Constants.ParkedEpoch
    )
    ClusterBuildPhase.create(
      cluster,
      "ParkAndLink",
      "Release into parked, then deliver by createlink"
    ).push(
      SyndicationScenario.planCrank(
        Actor.User,
        "park-unlinked",
        "advance the syndication queue",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.User,
        "parked-credit",
        "the net credit is parked and the account has zero",
        async ctx => {
          const row = await WireSyndicationTool.readParked(
            ctx,
            SyndicationScenario.Token,
            SysioSyndChainkind.CHAIN_KIND_SVM,
            SyndicationScenario.publicKey(ctx, Constants.Unlinked)
          )
          Assert.strictEqual(
            BigInt(row.balance),
            Constants.LaterAmount -
              (Constants.LaterAmount * BigInt(Constants.FeeBps)) /
                SyndicationScenario.BasisPoints
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(
              ctx,
              Constants.Unlinked.account
            ),
            0n
          )
        }
      ),
      SyndicationUserSteps.planLinkSolanaKey(
        Actor.User,
        "link-recipient",
        "createlink delivers the parked credit",
        SyndicationScenario.WriteOptions,
        Constants.Unlinked.account,
        Constants.Unlinked.keypairName
      ),
      verifyStep(
        Actor.User,
        "parked-delivered",
        "the exact net balance reached the linked account once",
        async ctx => {
          const row = await WireSyndicationTool.readParked(
            ctx,
            SyndicationScenario.Token,
            SysioSyndChainkind.CHAIN_KIND_SVM,
            SyndicationScenario.publicKey(ctx, Constants.Unlinked)
          )
          Assert.strictEqual(row ? BigInt(row.balance) : 0n, 0n)
          Assert.strictEqual(
            await SyndicationScenario.readBalance(
              ctx,
              Constants.Unlinked.account
            ),
            Constants.LaterAmount -
              (Constants.LaterAmount * BigInt(Constants.FeeBps)) /
                SyndicationScenario.BasisPoints
          )
        }
      )
    )
    WireSyndicationTool.planApproveAndClaim(
      cluster,
      "ApproveUnlinked",
      "approve and claim the parked recipient's bond",
      { timeoutMs: ProtocolTiming.SingleHopBudgetMs },
      SyndicationScenario.Bonder,
      Constants.ParkedRequest
    )
    this.planFinish(cluster)
  }
}
