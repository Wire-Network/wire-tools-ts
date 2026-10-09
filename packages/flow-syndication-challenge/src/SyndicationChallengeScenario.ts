import Assert from "node:assert"
import Fs from "node:fs/promises"
import Path from "node:path"

import { Level } from "@wireio/shared"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  ProtocolTiming,
  pollUntil,
  Report,
  SolanaLiqSyndicationTool,
  Steps,
  SyndicationScenario,
  WireSyndicationTool,
  WireClient,
  matchesProtoEnum,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { SyndicationChallengeScenarioConstants as Constants } from "./SyndicationChallengeScenarioConstants.js"
import type { SyndicationChallengeTraceOutput } from "./outputs/index.js"
import { SyndicationChallengeSteps as Challenge } from "./steps/index.js"

const { Actor } = Report,
  { SysioContractName, SysioSyndEnvelopeState, SysioBondRequestState } =
    SysioContracts

/** A challenge after partial release burns held shadow and the released amount out of forfeited bonds. */
export class SyndicationChallengeScenario extends SyndicationScenario {
  readonly name = "flow-syndication-challenge"
  readonly description =
    "Partial release, HELD challenge, INVALID burn and forfeit, then challenger payout and custody excess"
  override readonly defaults: ClusterBuildOptions = {
    // Contract console records use nodeop's default debug logger.
    logging: { levels: { console: Level.debug } },
    enableMockSyndicationImport: true,
    enableMockLiqPools: true,
    epochDurationSec: SyndicationScenario.EpochDurationSec,
    producerCount: 3,
    batchOperatorCount: 3,
    underwriterCount: 0
  }

  plan(cluster: ClusterBuild): void {
    this.planSetup(cluster, [Constants.User, Constants.Challenger])
    ClusterBuildPhase.create(
      cluster,
      "SeedBounty",
      "A real release fee funds a nonzero challenge bounty"
    ).push(
      Challenge.planFund(
        Actor.Underwriter,
        "fund-challenger",
        "transfer shadow from the imported bonder",
        SyndicationScenario.WriteOptions
      ),
      Steps.contracts.sysio.synd.planSetconfig(
        Actor.Sysio,
        "configure-seed",
        "leave one burst available after the fee seed",
        SyndicationScenario.WriteOptions,
        { ...Constants.Config, synd_burst: String(Constants.Amount) }
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "seed-syndication",
        "syndicate the fee-pot seed",
        SyndicationScenario.OutpostOptions,
        Constants.User.keypairName,
        Constants.Burst
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "seed-held",
        "verify held intake and its circulated custody attestation",
        SyndicationScenario.VerifyOptions,
        Constants.User,
        Constants.Burst,
        Constants.SeedEpoch,
        Constants.SeedRequest
      )
    )
    WireSyndicationTool.planBondEnvelope(
      cluster,
      "BondSeed",
      "bond the fee seed",
      SyndicationScenario.VerifyOptions,
      SyndicationScenario.Bonder,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      Constants.SeedEpoch
    )
    ClusterBuildPhase.create(
      cluster,
      "ReleaseSeed",
      "Fund the bounty from earned fees"
    ).push(
      SyndicationScenario.planCrank(
        Actor.User,
        "release-seed",
        "advance the syndication queue",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.Sysio,
        "bounty-funded",
        "the fee pot holds the full requested bounty",
        async ctx => {
          Assert.strictEqual(
            await SyndicationScenario.readFees(ctx),
            Constants.Bounty
          )
        }
      )
    )
    WireSyndicationTool.planApproveAndClaim(
      cluster,
      "ApproveSeed",
      "approve and reclaim the seed bond",
      SyndicationScenario.VerifyOptions,
      SyndicationScenario.Bonder,
      Constants.SeedRequest
    )
    ClusterBuildPhase.create(
      cluster,
      "ChallengedIntake",
      "Hold a syndication larger than the burst"
    ).push(
      Steps.contracts.sysio.synd.planSetconfig(
        Actor.Sysio,
        "configure-challenge",
        "cap releases at one tranche with no refill",
        SyndicationScenario.WriteOptions,
        Constants.Config
      ),
      verifyStep(
        Actor.Sysio,
        "snapshot-before-intake",
        "record exact pre-intake accounting",
        async ctx => {
          ctx.outputs.set(Constants.Before, {
            supply: SyndicationScenario.units(
              (
                await WireSyndicationTool.readShadowStat(
                  ctx,
                  SyndicationScenario.Token
                )
              ).supply
            ),
            holder: await SyndicationScenario.readBalance(
              ctx,
              Constants.User.account
            ),
            bonder: await SyndicationScenario.readBalance(
              ctx,
              SyndicationScenario.Bonder
            ),
            fees: await SyndicationScenario.readFees(ctx),
            challenger: await SyndicationScenario.readBalance(
              ctx,
              Constants.Challenger.account
            )
          })
        }
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "challenged-syndication",
        "syndicate twice the available burst",
        SyndicationScenario.OutpostOptions,
        Constants.User.keypairName,
        Constants.Amount
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "challenged-held",
        "verify held intake and its circulated custody attestation",
        SyndicationScenario.VerifyOptions,
        Constants.User,
        Constants.Amount,
        Constants.Epoch,
        Constants.Request
      )
    )
    WireSyndicationTool.planBondEnvelope(
      cluster,
      "BondChallenged",
      "bond the full challenged envelope",
      SyndicationScenario.VerifyOptions,
      SyndicationScenario.Bonder,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      Constants.Epoch
    )
    ClusterBuildPhase.create(
      cluster,
      "PartialReleaseAndHold",
      "Release exactly one tranche, then post the hold"
    ).push(
      SyndicationScenario.planCrank(
        Actor.User,
        "partial-release",
        "advance the syndication queue",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.Sysio,
        "partial-release",
        "the item retains S minus burst and the user keeps the net tranche",
        async ctx => {
          const envelope = await SyndicationScenario.readEnvelope(
              ctx,
              Constants.Epoch
            ),
            items = await WireSyndicationTool.readItems(
              ctx,
              SyndicationScenario.Chain,
              SyndicationScenario.Token,
              ctx.outputs.assert(Constants.Epoch)
            ),
            request = await WireSyndicationTool.readRequest(
              ctx,
              ctx.outputs.assert(Constants.Request)
            ),
            { rows } = await ctx.wire
              .getSysioContract(SysioContractName.bond)
              .tables.bondconfig.query({ limit: 1 })
          Assert.strictEqual(BigInt(envelope.released), Constants.Burst)
          Assert.strictEqual(
            items.reduce((total, item) => total + BigInt(item.remaining), 0n),
            Constants.Amount - Constants.Burst
          )
          Assert.strictEqual(BigInt(request.bounty), Constants.Bounty)
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.User.account),
            ctx.outputs.assert(Constants.Before).holder +
              Constants.Burst -
              (Constants.Burst * BigInt(Constants.FeeBps)) /
                SyndicationScenario.BasisPoints
          )
          ctx.outputs.set(
            Constants.Hold,
            (BigInt(request.covered) * BigInt(rows[0].hold_bps)) /
              SyndicationScenario.BasisPoints
          )
        }
      ),
      Challenge.planChallenge(
        Actor.User,
        "challenge",
        "post the hold bond plus challenge_extra",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.Sysio,
        "held-and-charged",
        "HELD on envelope and request, exact challenger charge and extra fee",
        async ctx => {
          const envelope = await SyndicationScenario.readEnvelope(
              ctx,
              Constants.Epoch
            ),
            request = await WireSyndicationTool.readRequest(
              ctx,
              ctx.outputs.assert(Constants.Request)
            ),
            before = ctx.outputs.assert(Constants.Before)
          Assert.ok(
            matchesProtoEnum(
              envelope.state,
              SysioSyndEnvelopeState,
              SysioSyndEnvelopeState.HELD
            )
          )
          Assert.ok(
            matchesProtoEnum(
              request.state,
              SysioBondRequestState,
              SysioBondRequestState.HELD
            )
          )
          Assert.strictEqual(
            BigInt(request.hold_bond),
            ctx.outputs.assert(Constants.Hold)
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(
              ctx,
              Constants.Challenger.account
            ),
            before.challenger -
              ctx.outputs.assert(Constants.Hold) -
              Constants.Extra
          )
          Assert.strictEqual(
            await SyndicationScenario.readFees(ctx),
            before.fees -
              Constants.Bounty +
              (Constants.Burst * BigInt(Constants.FeeBps)) /
                SyndicationScenario.BasisPoints +
              Constants.Extra
          )
        }
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "InvalidBurn",
      "Governance rules INVALID; crank burns held and released amounts"
    ).push(
      Challenge.planInvalid(
        Actor.Sysio,
        "rule-invalid",
        "rule the held request INVALID",
        SyndicationScenario.WriteOptions
      ),
      SyndicationScenario.planCrank(
        Actor.User,
        "burn-invalid",
        "advance the syndication queue",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.Sysio,
        "invalid-accounting",
        "supply returns to pre-intake; holder keeps payment; remainder of forfeit enters fees",
        async ctx => {
          const envelope = await SyndicationScenario.readEnvelope(
              ctx,
              Constants.Epoch
            ),
            request = await WireSyndicationTool.readRequest(
              ctx,
              ctx.outputs.assert(Constants.Request)
            ),
            before = ctx.outputs.assert(Constants.Before),
            items = await WireSyndicationTool.readItems(
              ctx,
              SyndicationScenario.Chain,
              SyndicationScenario.Token,
              ctx.outputs.assert(Constants.Epoch)
            )
          Assert.ok(
            matchesProtoEnum(
              envelope.state,
              SysioSyndEnvelopeState,
              SysioSyndEnvelopeState.INVALID
            )
          )
          Assert.strictEqual(BigInt(envelope.burned), Constants.Amount)
          Assert.strictEqual(
            items.reduce((total, item) => total + BigInt(item.remaining), 0n),
            0n
          )
          Assert.strictEqual(BigInt(envelope.forfeit), Constants.Amount)
          Assert.strictEqual(BigInt(request.forfeit_pending), 0n)
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
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.User.account),
            before.holder +
              Constants.Burst -
              (Constants.Burst * BigInt(Constants.FeeBps)) /
                SyndicationScenario.BasisPoints
          )
          Assert.strictEqual(
            await SyndicationScenario.readFees(ctx),
            before.fees -
              Constants.Bounty +
              (Constants.Burst * BigInt(Constants.FeeBps)) /
                SyndicationScenario.BasisPoints +
              Constants.Extra +
              Constants.Amount -
              Constants.Burst
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(
              ctx,
              SyndicationScenario.Bonder
            ),
            before.bonder - Constants.Amount
          )
        }
      ),
      Challenge.planClaim(
        Actor.User,
        "challenger-claim",
        "pay hold bond and bounty to the challenger",
        SyndicationScenario.WriteOptions,
        Constants.Challenger.account
      ),
      Challenge.planClaim(
        Actor.Underwriter,
        "bonder-empty-claim",
        "attempt the forfeited bonder's claim",
        SyndicationScenario.WriteOptions,
        SyndicationScenario.Bonder
      ),
      verifyStep(
        Actor.Sysio,
        "claims-settled",
        "challenger receives hold and bounty, bonder has nothing to claim",
        async ctx => {
          Assert.strictEqual(
            await SyndicationScenario.readBalance(
              ctx,
              Constants.Challenger.account
            ),
            ctx.outputs.assert(Constants.Before).challenger -
              Constants.Extra +
              Constants.Bounty
          )
          Assert.match(
            ctx.outputs.assert(Constants.ClaimError),
            /^$|nothing to claim/
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(
              ctx,
              SyndicationScenario.Bonder
            ),
            ctx.outputs.assert(Constants.Before).bonder - Constants.Amount
          )
        }
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "ExcessCustody",
      "The next admitted message observes the burned shadow as excess custody"
    ).push(
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "excess-probe",
        "send a distinct next syndication",
        SyndicationScenario.OutpostOptions,
        Constants.User.keypairName,
        Constants.ProbeAmount
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "probe-admitted",
        "verify held intake and its circulated custody attestation",
        SyndicationScenario.VerifyOptions,
        Constants.User,
        Constants.ProbeAmount,
        Constants.ProbeEpoch,
        Constants.ProbeRequest
      ),
      verifyStep(
        Actor.Sysio,
        "excess-without-mismatch",
        "custody retains the burned amount as excess and the next intake logs EXCESS",
        async ctx => {
          // Solana may report newly settled yield alongside this syndication.
          // Held yield is not outstanding yet, so it adds legitimate custody slack.
          Assert.ok(
            (await SolanaLiqSyndicationTool.readPoolBalance(ctx)) -
              (await WireSyndicationTool.readOutstanding(
                ctx,
                SyndicationScenario.Token
              )) >=
              Constants.Amount,
            "custody must retain at least the amount burned from the invalid envelope"
          )
          Assert.strictEqual(
            (await WireSyndicationTool.readMismatches(ctx)).length,
            0
          )
          const syndicationAccount =
              SysioContracts.SysioContractDefinitions[SysioContractName.synd]
                .account,
            logsPath = Path.join(ctx.config.clusterPath, "logs"),
            files = (await Fs.readdir(logsPath)).filter(file =>
              /^cluster_.*\.log$/.test(file)
            ),
            logs = await Promise.all(
              files.map(file => Fs.readFile(Path.join(logsPath, file), "utf8"))
            )
          const probeTransactions = new Set<string>()
          for (const line of logs.flatMap(value => value.split("\n"))) {
            if (
              !line.includes("[TRX_TRACE]") ||
              !line.includes("sysio.synd::onsynd: EXCESS")
            )
              continue
            const jsonStart = line.indexOf('{"id":')
            if (jsonStart < 0) continue
            const trace = JSON.parse(
              line.slice(jsonStart)
            ) as SyndicationChallengeTraceOutput
            if (trace.except != null) continue
            const probe = trace.action_traces.find(
              action =>
                action.receiver === syndicationAccount &&
                action.act.account === syndicationAccount &&
                action.act.name === "onsynd" &&
                action.act.data.epoch_index ===
                  ctx.outputs.assert(Constants.ProbeEpoch) &&
                action.act.data.chain_code === SyndicationScenario.Chain &&
                action.act.data.token_code === SyndicationScenario.Token &&
                BigInt(action.act.data.amount) === Constants.ProbeAmount &&
                action.console.includes("sysio.synd::onsynd: EXCESS")
            )
            if (!probe) continue
            probeTransactions.add(trace.id)
          }
          Assert.ok(
            probeTransactions.size > 0,
            "missing EXCESS trace for the probe's own epoch and amount"
          )
          // A speculative log alone is insufficient: locate a matching tx in
          // its actual irreversible block, even if its speculative height moved.
          await pollUntil(
            "the probe's EXCESS transaction is irreversible",
            async () => {
              const irreversible = (await ctx.wire.getInfo())
                .last_irreversible_block_num
              for (const id of probeTransactions) {
                const transaction = await ctx.wire.getTransaction(id)
                if (!transaction || transaction.block_num > irreversible)
                  continue
                const block = await ctx.wire.getBlock(transaction.block_num)
                if (WireClient.blockContainsTransaction(block, id)) return true
              }
              return false
            },
            ProtocolTiming.IrreversibilityBaseMs,
            SyndicationScenario.PollMs
          )
        },
        SyndicationScenario.VerifyOptions
      )
    )
    this.planFinish(cluster)
    ClusterBuildPhase.create(
      cluster,
      "SettleExcessProbe",
      "Release the successful probe to its wallet"
    ).push(
      WireSyndicationTool.planResolveEnvelope(
        Actor.Sysio,
        "resolve-probe",
        "sysio validates the successful custody probe",
        SyndicationScenario.VerifyOptions,
        SyndicationScenario.Chain,
        SyndicationScenario.Token,
        Constants.ProbeEpoch
      ),
      SyndicationScenario.planCrank(
        Actor.User,
        "release-probe",
        "release the probe after restoring normal budgets",
        SyndicationScenario.WriteOptions
      ),
      verifyStep(
        Actor.User,
        "probe-in-wallet",
        "the successful probe is fully credited to the destination",
        async ctx => {
          await pollUntil(
            "probe wallet settlement",
            async () =>
              BigInt(
                (
                  await SyndicationScenario.readEnvelope(
                    ctx,
                    Constants.ProbeEpoch
                  )
                ).released
              ) >= Constants.ProbeAmount &&
              (await SyndicationScenario.readBalance(
                ctx,
                Constants.User.account
              )) ===
                ctx.outputs.assert(Constants.Before).holder +
                  Constants.Burst -
                  (Constants.Burst * BigInt(Constants.FeeBps)) /
                    SyndicationScenario.BasisPoints +
                  Constants.ProbeAmount,
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
        },
        SyndicationScenario.VerifyOptions
      )
    )
  }
}
