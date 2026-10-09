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
  SolanaLiqSyndicationTool,
  Steps,
  SyndicationScenario,
  SyndicationUserSteps,
  WireSyndicationTool,
  matchesProtoEnum,
  pollStep,
  pollUntil,
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
    underwriterCount: 0,
    // The bonder's underwriter daemon starts outside `NodeConfig.plan`; its
    // ports are reserved with every planned node's.
    adHocCount: SyndicationScenario.AdHocDaemonCount
  }

  plan(cluster: ClusterBuild): void {
    // Every wait on the underwriter daemon is sized from the cluster's finalizers.
    const finalizerCount = cluster.config.producerCount
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
          Assert.strictEqual(BigInt(request.covered), Constants.FirstCovered)
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
    this.planUnderwriterStart(cluster, Constants.UnderwriterExposureCap)
    ClusterBuildPhase.create(
      cluster,
      "BondFirst",
      "The underwriter bonds the first request's remainder"
    ).push(
      WireSyndicationTool.planAwaitRequestBonded(
        Actor.Underwriter,
        "first-bonded",
        "the underwriter bonds the first request",
        SyndicationScenario.requestBondedOptions(finalizerCount),
        SyndicationScenario.Bonder,
        SyndicationScenario.Chain,
        SyndicationScenario.Token,
        Constants.FirstEpoch
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "ReleaseFirst",
      "The underwriter's crank releases S minus the fee and issues the next request"
    ).push(
      verifyStep(
        Actor.Sysio,
        "first-released-next-requested",
        "exact fee and linked credit; second request is now issued",
        async ctx => {
          await pollUntil(
            "the underwriter's crank releases the first envelope and issues the second request",
            async () =>
              BigInt(
                (
                  await SyndicationScenario.readEnvelope(
                    ctx,
                    Constants.FirstEpoch
                  )
                ).released
              ) === Constants.Amount &&
              WireSyndicationTool.isRequestIssued(
                await SyndicationScenario.readEnvelope(
                  ctx,
                  Constants.SecondEpoch
                )
              ),
            WireSyndicationTool.underwriterPassBudgetMs(finalizerCount),
            SyndicationScenario.PollMs
          )
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
        },
        SyndicationScenario.underwriterPassOptions(finalizerCount)
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "ApproveFirst",
      "The underwriter approves after the challenge window and claims its bond"
    ).push(
      WireSyndicationTool.planAwaitRequestSettled(
        Actor.Underwriter,
        "first-settled",
        "the first request is APPROVED and the bonder's bond paid",
        SyndicationScenario.requestSettledOptions(
          Constants.Config.window_sec,
          finalizerCount
        ),
        SyndicationScenario.Bonder,
        Constants.FirstRequest
      )
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
        SyndicationScenario.underwriterPassOptions(finalizerCount)
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "BondSecond",
      "The underwriter bonds the newly issued request once the first bond is paid"
    ).push(
      WireSyndicationTool.planAwaitRequestBonded(
        Actor.Underwriter,
        "second-bonded",
        "the underwriter bonds the second request",
        SyndicationScenario.requestBondedOptions(finalizerCount),
        SyndicationScenario.Bonder,
        SyndicationScenario.Chain,
        SyndicationScenario.Token,
        Constants.SecondEpoch
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "ReleaseSecond",
      "The underwriter's crank drains the second envelope"
    ).push(
      verifyStep(
        Actor.Sysio,
        "second-released",
        "the second envelope released its syndication",
        pollStep.lift(
          "the underwriter's crank releases the second envelope",
          async ctx =>
            BigInt(
              (
                await SyndicationScenario.readEnvelope(
                  ctx,
                  Constants.SecondEpoch
                )
              ).released
            ) === Constants.LaterAmount,
          WireSyndicationTool.underwriterPassBudgetMs(finalizerCount),
          SyndicationScenario.PollMs
        ),
        SyndicationScenario.underwriterPassOptions(finalizerCount)
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "ApproveSecond",
      "The underwriter approves and claims the second request"
    ).push(
      WireSyndicationTool.planAwaitRequestSettled(
        Actor.Underwriter,
        "second-settled",
        "the second request is APPROVED and the bonder's bond paid",
        SyndicationScenario.requestSettledOptions(
          Constants.Config.window_sec,
          finalizerCount
        ),
        SyndicationScenario.Bonder,
        Constants.SecondRequest
      )
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
      SyndicationScenario.planVerifyIssuedIntake(
        Actor.Sysio,
        "unlinked-intake",
        "verify intake and its circulated custody attestation",
        SyndicationScenario.VerifyOptions,
        Constants.Unlinked,
        Constants.LaterAmount,
        Constants.SecondEpoch,
        Constants.ParkedEpoch,
        Constants.ParkedRequest
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "BondUnlinked",
      "The underwriter bonds the unlinked recipient's request"
    ).push(
      WireSyndicationTool.planAwaitRequestBonded(
        Actor.Underwriter,
        "unlinked-bonded",
        "the underwriter bonds the unlinked recipient's request",
        SyndicationScenario.requestBondedOptions(finalizerCount),
        SyndicationScenario.Bonder,
        SyndicationScenario.Chain,
        SyndicationScenario.Token,
        Constants.ParkedEpoch
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "ParkAndLink",
      "The underwriter's crank releases into parked, then createlink delivers"
    ).push(
      verifyStep(
        Actor.User,
        "parked-credit",
        "the net credit is parked and the account has zero",
        async ctx => {
          const credit =
            Constants.LaterAmount -
            (Constants.LaterAmount * BigInt(Constants.FeeBps)) /
              SyndicationScenario.BasisPoints
          await pollUntil(
            "the underwriter's crank parks the unlinked recipient's credit",
            async () => {
              const row = await WireSyndicationTool.readParked(
                ctx,
                SyndicationScenario.Token,
                SysioSyndChainkind.CHAIN_KIND_SVM,
                SyndicationScenario.publicKey(ctx, Constants.Unlinked)
              )
              return row != null && BigInt(row.balance) === credit
            },
            WireSyndicationTool.underwriterPassBudgetMs(finalizerCount),
            SyndicationScenario.PollMs
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(
              ctx,
              Constants.Unlinked.account
            ),
            0n
          )
        },
        SyndicationScenario.underwriterPassOptions(finalizerCount)
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
    ClusterBuildPhase.create(
      cluster,
      "ApproveUnlinked",
      "The underwriter approves and claims the parked recipient's bond"
    ).push(
      WireSyndicationTool.planAwaitRequestSettled(
        Actor.Underwriter,
        "unlinked-settled",
        "the parked recipient's request is APPROVED and the bonder's bond paid",
        SyndicationScenario.requestSettledOptions(
          Constants.Config.window_sec,
          finalizerCount
        ),
        SyndicationScenario.Bonder,
        Constants.ParkedRequest
      )
    )
    this.planFinish(cluster)
  }
}
