import Assert from "node:assert"

import { oppDebuggingPath } from "@wireio/debugging-shared"
import {
  AttestationType,
  DebugOutpostEndpointsType,
  DesyndicateLIQ,
  SyndicateLIQ
} from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  Constants as HarnessConstants,
  EthereumSyndicationTool,
  PendingPayoutReason,
  ProtocolTiming,
  Report,
  SolanaFundingTool,
  SolanaLiqSyndicationTool,
  Steps,
  StepExtraRecorder,
  SyndicationScenario,
  WireSyndicationTool,
  pollUntil,
  matchesProtoEnum,
  readEnvelopeAttestations,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { EmergencyStopScenarioConstants as Constants } from "./EmergencyStopScenarioConstants.js"
import { EmergencyStopSteps } from "./steps/index.js"

const { Actor } = Report,
  { Action, ScriptCommand } = EmergencyStopSteps,
  { SysioContractName } = SysioContracts,
  write = SyndicationScenario.WriteOptions,
  outpost = SyndicationScenario.OutpostOptions,
  verify = SyndicationScenario.VerifyOptions

/** Freeze both outposts, preserve consensus and custody, then settle each stored payout once. */
export class EmergencyStopScenario extends SyndicationScenario {
  readonly name = "flow-emergency-stop"
  readonly description =
    "Andon cord, deferred payouts, automatic shortfall pull and recovery"
  override readonly defaults: ClusterBuildOptions = {
    enableMockSyndicationImport: true,
    enableMockLiqPools: true,
    epochDurationSec: SyndicationScenario.EpochDurationSec,
    producerCount: 3,
    batchOperatorCount: 3,
    underwriterCount: 1
  }
  plan(cluster: ClusterBuild): void {
    this.planSetup(cluster, [Constants.User])
    ClusterBuildPhase.create(
      cluster,
      "InitialIntake",
      "Create redeemable shadow"
    ).push(
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "initial-syndication",
        "lock principal",
        outpost,
        Constants.User.keypairName,
        Constants.Amount
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "initial-held",
        "intake is held",
        verify,
        Constants.User,
        Constants.Amount,
        Constants.FirstEpoch,
        Constants.FirstRequest
      )
    )
    WireSyndicationTool.planBondEnvelope(
      cluster,
      "InitialBond",
      "bond principal",
      verify,
      SyndicationScenario.Bonder,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      Constants.FirstEpoch
    )
    ClusterBuildPhase.create(
      cluster,
      "InitialRelease",
      "Deliver principal"
    ).push(
      SyndicationScenario.planCrank(
        Actor.User,
        "initial-release",
        "release principal",
        write
      ),
      verifyStep(
        Actor.User,
        "initial-balance",
        "holder owns redeemable principal",
        async ctx => {
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.User.account),
            Constants.Amount
          )
        }
      )
    )
    WireSyndicationTool.planApproveAndClaim(
      cluster,
      "InitialClaim",
      "return the initial bond",
      verify,
      SyndicationScenario.Bonder,
      Constants.FirstRequest
    )
    ClusterBuildPhase.create(
      cluster,
      "PrepareFrozenWork",
      "Queue work that will fall due while pulled"
    ).push(
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "held-syndication",
        "lock later principal",
        outpost,
        Constants.User.keypairName,
        Constants.HeldAmount
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "held-intake",
        "second envelope is held",
        verify,
        Constants.User,
        Constants.HeldAmount,
        Constants.HeldEpoch,
        Constants.HeldRequest
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "SolanaFreeze",
      "Freeze the outpost and store a depot redemption"
    ).push(
      SolanaLiqSyndicationTool.planSetFrozen(
        Actor.SolanaOutpost,
        "freeze-solana",
        "panic sets frozen",
        outpost,
        SolanaFundingTool.PanicKeypairName,
        true
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "frozen-state",
        "record freeze epoch and unchanged holder balance",
        async ctx => {
          Assert.strictEqual(
            await SolanaLiqSyndicationTool.readGlobalStateFrozen(ctx),
            true
          )
          ctx.outputs.set(
            Constants.FreezeEpoch,
            await SyndicationScenario.readEpoch(ctx)
          )
          ctx.outputs.set(
            Constants.BalanceBefore,
            await SolanaLiqSyndicationTool.readLiqsolBalance(
              ctx,
              Constants.User.keypairName
            )
          )
        }
      ),
      EmergencyStopSteps.planAction(
        Actor.User,
        "frozen-synd-refused",
        "synd refuses OutpostFrozen",
        outpost,
        Action.synd,
        "0x17c7"
      ),
      Steps.contracts.sysio.synd.planDesyndicate(
        Actor.User,
        "frozen-redemption",
        "burn and queue DESYNDICATE_LIQ",
        write,
        {
          holder: Constants.User.account,
          quantity: SyndicationScenario.quantity(Constants.Payout)
        }
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "payout-stored",
        "decoded payout is stored with no ATA payment and epochs advance",
        async ctx => {
          await pollUntil(
            "frozen PendingPayout",
            async () => {
              const records =
                  await SolanaLiqSyndicationTool.readPendingPayouts(ctx),
                record = records.find(
                  value =>
                    value.user.toBuffer().toString("hex") ===
                    SyndicationScenario.publicKey(ctx, Constants.User)
                )
              if (!record) return false
              ctx.outputs.set(Constants.Pending, record)
              return true
            },
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
          const record = ctx.outputs.assert(Constants.Pending),
            messages = (
              await readEnvelopeAttestations(
                oppDebuggingPath(ctx.config.clusterPath),
                DebugOutpostEndpointsType.DEPOT_OUTPOST_SOLANA,
                AttestationType.DESYNDICATE_LIQ
              )
            ).map(bytes => DesyndicateLIQ.fromBinary(bytes)),
            message = messages.find(
              value => value.requestId === record.requestId
            )
          Assert.ok(message, "missing decoded DESYNDICATE_LIQ")
          Assert.strictEqual(message.amount.amount, Constants.Payout)
          Assert.strictEqual(record.amount, Constants.Payout)
          Assert.strictEqual(record.reason, PendingPayoutReason.outpostFrozen)
          Assert.strictEqual(record.tokenCode, SyndicationScenario.TokenCode)
          Assert.strictEqual(
            await SolanaLiqSyndicationTool.readLiqsolBalance(
              ctx,
              Constants.User.keypairName
            ),
            ctx.outputs.assert(Constants.BalanceBefore)
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.User.account),
            Constants.Remaining
          )
          Assert.ok(
            (await SyndicationScenario.readEpoch(ctx)) >
              ctx.outputs.assert(Constants.FreezeEpoch)
          )
        },
        verify
      ),
      EmergencyStopSteps.planScript(
        Actor.SolanaOutpost,
        "script-status",
        "packaged status confirms frozen",
        verify,
        ScriptCommand.status
      ),
      EmergencyStopSteps.planScript(
        Actor.SolanaOutpost,
        "script-pending",
        "packaged pending identifies the stored payout",
        verify,
        ScriptCommand.pending
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "DepotPull",
      "Pull while allowing intake and bonding"
    ).push(
      Steps.contracts.sysio.andon.planPull(
        Actor.Sysio,
        "pull-depot",
        "panic pulls the depot cord",
        write,
        {
          actor: HarnessConstants.PANIC_ACCOUNT,
          reason: "E7 deliberate emergency stop"
        }
      ),
      verifyStep(
        Actor.Sysio,
        "pull-snapshot",
        "cord is pulled and capture bucket levels",
        async ctx => {
          const cord = await WireSyndicationTool.readCord(ctx)
          Assert.ok(cord.pulled)
          Assert.strictEqual(cord.pulled_by, HarnessConstants.PANIC_ACCOUNT)
          const { rows, more } = await ctx.wire
            .getSysioContract(SysioContractName.synd)
            .tables.buckets.query({ limit: SyndicationScenario.QueryLimit })
          Assert.ok(!more)
          ctx.outputs.set(Constants.Buckets, rows)
          const audit = await ctx.wire
            .getSysioContract(SysioContractName.msgch)
            .tables.envlog.query({ limit: SyndicationScenario.QueryLimit })
          Assert.ok(!audit.more)
          ctx.outputs.set(
            Constants.EnvelopeLogId,
            audit.rows.reduce(
              (maximum, row) =>
                BigInt(row.id) > maximum ? BigInt(row.id) : maximum,
              0n
            )
          )
          ctx.outputs.set(
            Constants.FreezeEpoch,
            await SyndicationScenario.readEpoch(ctx)
          )
        }
      )
    )
    WireSyndicationTool.planBondEnvelope(
      cluster,
      "AcceptWhilePulled",
      "accept remains live under the cord",
      verify,
      SyndicationScenario.Bonder,
      SyndicationScenario.Chain,
      SyndicationScenario.Token,
      Constants.HeldEpoch
    )
    ClusterBuildPhase.create(
      cluster,
      "FrozenDepotGates",
      "Custody remains held, while challenge and consensus work"
    ).push(
      SyndicationScenario.planCrank(
        Actor.User,
        "frozen-crank",
        "crank cannot release the bonded envelope",
        write
      ),
      verifyStep(
        Actor.Sysio,
        "no-release",
        "the bonded envelope and holder balance did not move",
        async ctx => {
          Assert.strictEqual(
            BigInt(
              (await SyndicationScenario.readEnvelope(ctx, Constants.HeldEpoch))
                .released
            ),
            0n
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.User.account),
            Constants.Remaining
          )
        }
      ),
      EmergencyStopSteps.planAction(
        Actor.User,
        "depot-desyndication-refused",
        "desyndicate cannot leave custody",
        write,
        Action.desyndicate,
        "andon cord is pulled"
      ),
      EmergencyStopSteps.planAction(
        Actor.User,
        "plain-transfer-refused",
        "plain-account transfer is frozen",
        write,
        Action.transfer,
        "andon cord is pulled"
      ),
      EmergencyStopSteps.planAction(
        Actor.User,
        "challenge-while-pulled",
        "challenge still runs",
        write,
        Action.challenge
      ),
      EmergencyStopSteps.planAction(
        Actor.Sysio,
        "valid-ruling",
        "resolve challenge as valid while pulled",
        write,
        Action.valid
      ),
      EmergencyStopSteps.planAction(
        Actor.Underwriter,
        "claim-refused",
        "claim cannot leave custody",
        write,
        Action.claim,
        "andon cord is pulled"
      ),
      verifyStep(
        Actor.BatchOperator,
        "frozen-epochs-and-buckets",
        "envelopes keep circulating and bucket levels stay fixed",
        async ctx => {
          await pollUntil(
            "epoch advance under depot cord",
            async () =>
              (await SyndicationScenario.readEpoch(ctx)) >
              ctx.outputs.assert(Constants.FreezeEpoch),
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
          const { rows, more } = await ctx.wire
            .getSysioContract(SysioContractName.synd)
            .tables.buckets.query({ limit: SyndicationScenario.QueryLimit })
          Assert.ok(!more)
          Assert.deepStrictEqual(rows, ctx.outputs.assert(Constants.Buckets))
          const audit = await ctx.wire
            .getSysioContract(SysioContractName.msgch)
            .tables.envlog.query({ limit: SyndicationScenario.QueryLimit })
          Assert.ok(!audit.more)
          Assert.ok(
            audit.rows.some(
              row =>
                BigInt(row.id) > ctx.outputs.assert(Constants.EnvelopeLogId) &&
                matchesProtoEnum(
                  row.endpoints.start.kind,
                  SysioContracts.SysioMsgchChainkind,
                  SysioContracts.SysioMsgchChainkind.CHAIN_KIND_SVM
                )
            ),
            "msgch accepted no new Solana envelope while pulled"
          )
          Assert.strictEqual(
            BigInt(
              (await SyndicationScenario.readEnvelope(ctx, Constants.HeldEpoch))
                .released
            ),
            0n
          )
        },
        verify
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "Recovery",
      "Clear outposts first, then the depot; pay and release once"
    ).push(
      EmergencyStopSteps.planAction(
        Actor.User,
        "frozen-solana-payment-refused",
        "pending payout refuses OutpostFrozen before clearing",
        outpost,
        Action.paySolana,
        "0x17c7"
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "frozen-solana-payment-unchanged",
        "frozen refusal preserves the entire payout and holder balance",
        async ctx => {
          Assert.strictEqual(
            await SolanaLiqSyndicationTool.readGlobalStateFrozen(ctx),
            true
          )
          Assert.deepStrictEqual(
            await SolanaLiqSyndicationTool.readPendingPayout(
              ctx,
              ctx.outputs.assert(Constants.Pending).requestId
            ),
            ctx.outputs.assert(Constants.Pending)
          )
          Assert.strictEqual(
            await SolanaLiqSyndicationTool.readLiqsolBalance(
              ctx,
              Constants.User.keypairName
            ),
            ctx.outputs.assert(Constants.BalanceBefore)
          )
        }
      ),
      SolanaLiqSyndicationTool.planSetFrozen(
        Actor.SolanaOutpost,
        "clear-solana",
        "panic clears frozen",
        outpost,
        SolanaFundingTool.PanicKeypairName,
        false
      ),
      Steps.contracts.sysio.andon.planClear(
        Actor.Sysio,
        "clear-depot",
        "clear after outpost recovery",
        write,
        { actor: HarnessConstants.PANIC_ACCOUNT, note: "outpost clear" }
      ),
      EmergencyStopSteps.planAction(
        Actor.User,
        "pay-pending-solana",
        "pay stored principal",
        outpost,
        Action.paySolana
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "solana-paid-once",
        "ATA increases by stored amount and PDA closes",
        async ctx => {
          Assert.strictEqual(
            await SolanaLiqSyndicationTool.readLiqsolBalance(
              ctx,
              Constants.User.keypairName
            ),
            ctx.outputs.assert(Constants.BalanceBefore) + Constants.Payout
          )
          Assert.ok(
            !(await SolanaLiqSyndicationTool.readPendingPayout(
              ctx,
              ctx.outputs.assert(Constants.Pending).requestId
            ))
          )
        }
      ),
      EmergencyStopSteps.planAction(
        Actor.User,
        "second-solana-payment-refused",
        "closed PDA refuses a second on-chain payment",
        outpost,
        Action.replaySolana,
        "0xbc4"
      ),
      SyndicationScenario.planCrank(
        Actor.User,
        "recovery-crank",
        "next crank releases due work",
        write
      ),
      verifyStep(
        Actor.Sysio,
        "due-work-released",
        "held principal released and payout not repeated",
        async ctx => {
          Assert.strictEqual(
            BigInt(
              (await SyndicationScenario.readEnvelope(ctx, Constants.HeldEpoch))
                .released
            ),
            Constants.HeldAmount
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.User.account),
            Constants.Remaining + Constants.HeldAmount
          )
          Assert.strictEqual(
            await SolanaLiqSyndicationTool.readLiqsolBalance(
              ctx,
              Constants.User.keypairName
            ),
            ctx.outputs.assert(Constants.BalanceBefore) + Constants.Payout
          )
        }
      )
    )
    this.planShortfall(cluster)
    this.planEthereum(cluster)
  }
  /** The next real syndication detects measured unbacked shadow and the next backed one adds no mismatch. */
  private planShortfall(cluster: ClusterBuild): void {
    ClusterBuildPhase.create(
      cluster,
      "AutomaticDepotPull",
      "Create a measured custody shortfall"
    ).push(
      verifyStep(
        Actor.Sysio,
        "measure-solana-shortfall",
        "read both sides before governance recredit",
        async ctx => {
          const custody = await SolanaLiqSyndicationTool.readPoolBalance(ctx),
            outstanding = await WireSyndicationTool.readOutstanding(
              ctx,
              SyndicationScenario.Token
            )
          Assert.ok(custody >= outstanding)
          Assert.deepStrictEqual(
            await WireSyndicationTool.readMismatches(ctx),
            []
          )
          ctx.outputs.set(
            Constants.Shortfall,
            custody - outstanding + Constants.Deficit
          )
        }
      ),
      EmergencyStopSteps.planAction(
        Actor.Sysio,
        "unbacked-solana-recredit",
        "recredit measured slack plus deficit",
        write,
        Action.recreditSolana
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "shortfall-message",
        "real syndication reports custody",
        outpost,
        Constants.User.keypairName,
        Constants.ProbeAmount
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "shortfall-intake",
        "message admitted and held",
        verify,
        Constants.User,
        Constants.ProbeAmount,
        Constants.ProbeEpoch,
        Constants.ProbeRequest
      ),
      verifyStep(
        Actor.Sysio,
        "automatic-pull-evidence",
        "one mismatch records reported custody and post-mint outstanding",
        async ctx => {
          const rows = await WireSyndicationTool.readMismatches(ctx),
            cord = await WireSyndicationTool.readCord(ctx),
            messages = (
              await readEnvelopeAttestations(
                oppDebuggingPath(ctx.config.clusterPath),
                DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
                AttestationType.SYNDICATE_LIQ
              )
            ).map(bytes => SyndicateLIQ.fromBinary(bytes)),
            message = messages.find(
              value => value.amount.amount === Constants.ProbeAmount
            )
          Assert.ok(message, "missing shortfall syndication attestation")
          StepExtraRecorder.note(
            "Complete mismatch evidence at automatic pull",
            { mismatches: rows }
          )
          const matchingRows = rows.filter(
            row =>
              row.chain_code === SyndicationScenario.Chain &&
              BigInt(row.sequence) === message.sequence
          )
          Assert.strictEqual(matchingRows.length, 1)
          const mismatch = matchingRows[0]
          EmergencyStopSteps.assertProbeMismatchIdentity(
            mismatch,
            ctx.outputs.assert(Constants.ProbeEpoch)
          )
          Assert.strictEqual(BigInt(mismatch.sequence), message.sequence)
          Assert.strictEqual(BigInt(mismatch.reported), message.totalSyndicated)
          Assert.strictEqual(
            BigInt(mismatch.reported),
            await SolanaLiqSyndicationTool.readPoolBalance(ctx)
          )
          Assert.strictEqual(
            BigInt(mismatch.expected),
            await WireSyndicationTool.readOutstanding(
              ctx,
              SyndicationScenario.Token
            )
          )
          // Syndication also claims accrued pool yield, so the measured deficit
          // need not equal the recredit target. Both sides above are exact.
          Assert.ok(
            BigInt(mismatch.expected) > BigInt(mismatch.reported),
            "reported custody must be below outstanding"
          )
          Assert.ok(cord.pulled)
          Assert.strictEqual(
            cord.pulled_by,
            SysioContracts.SysioContractAccount.synd
          )
          ctx.outputs.set(Constants.Mismatches, rows)
        }
      ),
      EmergencyStopSteps.planAction(
        Actor.User,
        "repair-solana-custody",
        "donate the measured recredit amount",
        outpost,
        Action.donateSolana
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "backed-message",
        "next syndication reports backed custody",
        outpost,
        Constants.User.keypairName,
        Constants.ProbeAmount + Constants.Deficit
      ),
      SyndicationScenario.planVerifyIntake(
        Actor.Sysio,
        "backed-intake",
        "next message admitted",
        verify,
        Constants.User,
        Constants.ProbeAmount + Constants.Deficit,
        Constants.RecoveryEpoch,
        Constants.RecoveryRequest
      ),
      verifyStep(
        Actor.Sysio,
        "repair-message-admitted",
        "cursor admits repaired custody before the depot cord clears",
        async ctx => {
          const messages = (
              await readEnvelopeAttestations(
                oppDebuggingPath(ctx.config.clusterPath),
                DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
                AttestationType.SYNDICATE_LIQ
              )
            ).map(bytes => SyndicateLIQ.fromBinary(bytes)),
            message = messages.find(
              value =>
                value.amount.amount ===
                Constants.ProbeAmount + Constants.Deficit
            )
          Assert.ok(message, "missing post-repair syndication attestation")
          ctx.outputs.set(Constants.RecoverySequence, message.sequence)
          await pollUntil(
            "depot cursor reaches post-repair Solana sequence",
            async () => {
              const { rows, more } = await ctx.wire
                .getSysioContract(SysioContractName.synd)
                .tables.syndcursors.query({
                  limit: SyndicationScenario.QueryLimit
                })
              Assert.ok(!more)
              const cursor = rows.find(
                row => row.chain_code === SyndicationScenario.Chain
              )
              if (!cursor || BigInt(cursor.last_sequence) < message.sequence)
                return false
              StepExtraRecorder.note(
                "Post-repair message admitted; all pre-repair sequences admitted or dropped",
                {
                  sequence: message.sequence.toString(),
                  reportedCustody: message.totalSyndicated.toString(),
                  cursor
                }
              )
              return true
            },
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
          const rows = await WireSyndicationTool.readMismatches(ctx)
          StepExtraRecorder.note(
            "Complete mismatch evidence before clear, including pre-repair messages in flight",
            {
              recoverySequence: message.sequence.toString(),
              mismatches: rows
            }
          )
          EmergencyStopSteps.assertRecoveryMismatches(rows, message.sequence)
          for (const original of ctx.outputs.assert(Constants.Mismatches)) {
            const current = rows.filter(
              row =>
                row.chain_code === original.chain_code &&
                row.token_code === original.token_code
            )
            Assert.strictEqual(current.length, 1)
            Assert.ok(BigInt(current[0].sequence) >= BigInt(original.sequence))
          }
          Assert.ok((await WireSyndicationTool.readCord(ctx)).pulled)
          ctx.outputs.set(Constants.Mismatches, rows)
        },
        verify
      ),
      EmergencyStopSteps.planAction(
        Actor.Sysio,
        "reconcile-shortfall",
        "attest repaired custody and remove the active incident",
        write,
        Action.reconcileSolana
      ),
      verifyStep(
        Actor.Sysio,
        "reconciled-still-stopped",
        "incident resolved while the emergency cord remains pulled",
        async ctx => {
          Assert.deepStrictEqual(
            await WireSyndicationTool.readMismatches(ctx),
            []
          )
          Assert.ok((await WireSyndicationTool.readCord(ctx)).pulled)
          ctx.outputs.set(Constants.Mismatches, [])
        }
      ),
      Steps.contracts.sysio.andon.planClear(
        Actor.Sysio,
        "clear-shortfall",
        "clear after the repaired message is admitted",
        write,
        {
          actor: HarnessConstants.PANIC_ACCOUNT,
          note: "repaired custody admitted"
        }
      ),
      verifyStep(
        Actor.Sysio,
        "no-new-mismatch",
        "no active incident with cord clear",
        async ctx => {
          const mismatches = await WireSyndicationTool.readMismatches(ctx)
          StepExtraRecorder.note("Complete mismatch evidence after clear", {
            recoverySequence: ctx.outputs
              .assert(Constants.RecoverySequence)
              .toString(),
            mismatches
          })
          EmergencyStopSteps.assertRecoveryMismatches(
            mismatches,
            ctx.outputs.assert(Constants.RecoverySequence)
          )
          Assert.deepStrictEqual(
            mismatches,
            ctx.outputs.assert(Constants.Mismatches)
          )
          Assert.ok(!(await WireSyndicationTool.readCord(ctx)).pulled)
        }
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "SettleRecoveryDeposits",
      "Release both repaired-custody deposits to the user"
    ).push(
      WireSyndicationTool.planResolveEnvelope(
        Actor.Sysio,
        "resolve-shortfall-probe",
        "sysio validates the repaired probe",
        verify,
        SyndicationScenario.Chain,
        SyndicationScenario.Token,
        Constants.ProbeEpoch
      ),
      SyndicationScenario.planCrank(
        Actor.User,
        "release-shortfall-probe",
        "release principal and advance FIFO",
        write
      ),
      WireSyndicationTool.planResolveEnvelope(
        Actor.Sysio,
        "resolve-recovery-probe",
        "sysio validates the backed follow-up",
        verify,
        SyndicationScenario.Chain,
        SyndicationScenario.Token,
        Constants.RecoveryEpoch
      ),
      SyndicationScenario.planCrank(
        Actor.User,
        "release-recovery-probe",
        "release all recovery principal",
        write
      ),
      verifyStep(
        Actor.User,
        "recovery-deposits-in-wallet",
        "both successful deposits reach the destination",
        async ctx => {
          await pollUntil(
            "recovery wallet settlement",
            async () =>
              (await SyndicationScenario.readBalance(
                ctx,
                Constants.User.account
              )) ===
              Constants.Remaining +
                Constants.HeldAmount +
                ctx.outputs.assert(Constants.Shortfall) +
                Constants.ProbeAmount * 2n +
                Constants.Deficit,
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
        },
        verify
      )
    )
  }
  /** Ethereum pause and custody-shortfall lanes both store and later pay exactly once. */
  private planEthereum(cluster: ClusterBuild): void {
    ClusterBuildPhase.create(
      cluster,
      "EthereumSetup",
      "Link the imported LIQETH position"
    ).push(
      EmergencyStopSteps.planAction(
        Actor.User,
        "link-imported-ethereum",
        "sweep imported Ethereum position",
        write,
        Action.linkEthereum
      ),
      EthereumSyndicationTool.planDepositLiqEth(
        Actor.User,
        "fund-ethereum-donor",
        "deposit for recovery custody",
        outpost,
        Constants.EthereumDonor,
        Constants.Amount * Constants.EthereumScale
      )
    )
    this.planEthereumPayout(cluster, false)
    this.planEthereumPayout(cluster, true)
    ClusterBuildPhase.create(
      cluster,
      "FinalSafety",
      "All flags clear with pre-repair audit evidence preserved"
    ).push(
      verifyStep(
        Actor.Sysio,
        "final-safety",
        "clear freezes, no pending payouts and no new mismatches",
        async ctx => {
          Assert.ok(!(await WireSyndicationTool.readCord(ctx)).pulled)
          Assert.strictEqual(
            await SolanaLiqSyndicationTool.readGlobalStateFrozen(ctx),
            false
          )
          Assert.strictEqual(
            await EthereumSyndicationTool.readPaused(ctx),
            false
          )
          Assert.deepStrictEqual(
            await SolanaLiqSyndicationTool.readPendingPayouts(ctx),
            []
          )
          Assert.ok(
            !(await EthereumSyndicationTool.readPendingDesyndication(
              ctx,
              ctx.outputs.assert(Constants.EthereumRequest)
            ))
          )
          const mismatches = await WireSyndicationTool.readMismatches(ctx)
          StepExtraRecorder.note("Complete mismatch evidence after clear", {
            recoverySequence: ctx.outputs
              .assert(Constants.RecoverySequence)
              .toString(),
            mismatches
          })
          EmergencyStopSteps.assertRecoveryMismatches(
            mismatches,
            ctx.outputs.assert(Constants.RecoverySequence)
          )
          Assert.deepStrictEqual(
            mismatches,
            ctx.outputs.assert(Constants.Mismatches)
          )
        }
      )
    )
  }
  /** One Ethereum deferred payout, selected by the deliberate cause. */
  private planEthereumPayout(cluster: ClusterBuild, shortfall: boolean): void {
    const phase = ClusterBuildPhase.create(
      cluster,
      shortfall ? "EthereumShortfall" : "EthereumPause",
      "Store and recover one Ethereum redemption"
    )
    if (shortfall)
      phase.push(
        verifyStep(
          Actor.Sysio,
          "measure-ethereum-shortfall",
          "measure custody and outstanding",
          async ctx => {
            const custody =
                await EthereumSyndicationTool.readPoolBalanceDepot(ctx),
              outstanding = await WireSyndicationTool.readOutstanding(
                ctx,
                Constants.EthereumToken
              )
            Assert.ok(custody >= outstanding)
            ctx.outputs.set(
              Constants.Shortfall,
              custody - outstanding + Constants.Deficit
            )
          }
        ),
        EmergencyStopSteps.planAction(
          Actor.Sysio,
          "unbacked-ethereum-recredit",
          "create measured unbacked LIQETH",
          write,
          Action.recreditEthereum
        )
      )
    else
      phase.push(
        EthereumSyndicationTool.planSetPaused(
          Actor.EthereumOutpost,
          "pause-ethereum",
          "panic pauses SyndicationPool",
          outpost,
          true
        )
      )
    phase.push(
      verifyStep(
        Actor.User,
        "ethereum-before",
        "record native balance and last depot request",
        async ctx => {
          ctx.outputs.set(
            Constants.EthereumBefore,
            await EthereumSyndicationTool.readLiqEthBalance(
              ctx,
              EmergencyStopScenario.ethereumAddress(ctx)
            )
          )
          const { rows, more } = await ctx.wire
            .getSysioContract(SysioContractName.synd)
            .tables.returns.query({ limit: SyndicationScenario.QueryLimit })
          Assert.ok(!more)
          ctx.outputs.set(
            Constants.LastRequest,
            rows.reduce(
              (maximum, row) =>
                BigInt(row.request_id) > maximum
                  ? BigInt(row.request_id)
                  : maximum,
              0n
            )
          )
          Assert.strictEqual(
            await EthereumSyndicationTool.readPaused(ctx),
            !shortfall
          )
        }
      ),
      Steps.contracts.sysio.synd.planDesyndicate(
        Actor.User,
        "ethereum-redemption",
        "burn imported LIQETH",
        write,
        {
          holder: SyndicationScenario.Bonder,
          quantity: SyndicationScenario.quantity(Constants.Payout).replace(
            SyndicationScenario.Token,
            Constants.EthereumToken
          )
        }
      ),
      verifyStep(
        Actor.EthereumOutpost,
        "ethereum-stored",
        "pending reason, recipient, exact depot amount and unchanged wei",
        async ctx => {
          await pollUntil(
            "Ethereum deferred payout",
            async () => {
              const { rows, more } = await ctx.wire
                .getSysioContract(SysioContractName.synd)
                .tables.returns.query({
                  limit: SyndicationScenario.QueryLimit
                })
              Assert.ok(!more)
              const row = rows.find(
                value =>
                  value.token_code === Constants.EthereumToken &&
                  BigInt(value.request_id) >
                    ctx.outputs.assert(Constants.LastRequest)
              )
              if (!row) return false
              const requestId = BigInt(row.request_id),
                pending =
                  await EthereumSyndicationTool.readPendingDesyndication(
                    ctx,
                    requestId
                  )
              if (!pending) return false
              ctx.outputs.set(Constants.EthereumRequest, requestId)
              ctx.outputs.set(Constants.EthereumPending, pending)
              Assert.strictEqual(pending.depotAmount, Constants.Payout)
              Assert.strictEqual(
                pending.recipient.toLowerCase(),
                EmergencyStopScenario.ethereumAddress(ctx).toLowerCase()
              )
              Assert.strictEqual(
                pending.reason,
                shortfall
                  ? EthereumSyndicationTool.PendingPayoutReason
                      .CUSTODY_SHORTFALL
                  : EthereumSyndicationTool.PendingPayoutReason.OUTPOST_FROZEN
              )
              return true
            },
            ProtocolTiming.SingleHopBudgetMs,
            SyndicationScenario.PollMs
          )
          Assert.strictEqual(
            await EthereumSyndicationTool.readPaused(ctx),
            true
          )
          Assert.strictEqual(
            await EthereumSyndicationTool.readLiqEthBalance(
              ctx,
              EmergencyStopScenario.ethereumAddress(ctx)
            ),
            ctx.outputs.assert(Constants.EthereumBefore)
          )
        },
        verify
      )
    )
    if (shortfall)
      phase.push(
        EmergencyStopSteps.planAction(
          Actor.User,
          "repair-ethereum-custody",
          "donate measured missing custody",
          outpost,
          Action.donateEthereum
        )
      )
    phase.push(
      EmergencyStopSteps.planAction(
        Actor.User,
        "paused-ethereum-payment-refused",
        "pending payout refuses EnforcedPause before clearing",
        outpost,
        Action.payEthereum,
        "EnforcedPause"
      ),
      verifyStep(
        Actor.EthereumOutpost,
        "paused-ethereum-payment-unchanged",
        "paused refusal preserves the entire payout and holder balance",
        async ctx => {
          Assert.strictEqual(
            await EthereumSyndicationTool.readPaused(ctx),
            true
          )
          Assert.deepStrictEqual(
            await EthereumSyndicationTool.readPendingDesyndication(
              ctx,
              ctx.outputs.assert(Constants.EthereumRequest)
            ),
            ctx.outputs.assert(Constants.EthereumPending)
          )
          Assert.strictEqual(
            await EthereumSyndicationTool.readLiqEthBalance(
              ctx,
              EmergencyStopScenario.ethereumAddress(ctx)
            ),
            ctx.outputs.assert(Constants.EthereumBefore)
          )
        }
      ),
      EthereumSyndicationTool.planSetPaused(
        Actor.EthereumOutpost,
        "unpause-ethereum",
        "panic clears after repair",
        outpost,
        false
      ),
      EmergencyStopSteps.planAction(
        Actor.User,
        "pay-ethereum",
        "permissionless pending payout",
        outpost,
        Action.payEthereum
      ),
      verifyStep(
        Actor.User,
        "ethereum-paid",
        "native payout equals depot units scaled to wei",
        async ctx => {
          Assert.strictEqual(
            await EthereumSyndicationTool.readLiqEthBalance(
              ctx,
              EmergencyStopScenario.ethereumAddress(ctx)
            ),
            ctx.outputs.assert(Constants.EthereumBefore) +
              Constants.Payout * Constants.EthereumScale
          )
          Assert.ok(
            !(await EthereumSyndicationTool.readPendingDesyndication(
              ctx,
              ctx.outputs.assert(Constants.EthereumRequest)
            ))
          )
        }
      ),
      EmergencyStopSteps.planAction(
        Actor.User,
        "second-ethereum-payment-refused",
        "same request cannot pay twice",
        outpost,
        Action.payEthereum,
        "WIRE_NoPendingDesyndication"
      ),
      verifyStep(
        Actor.User,
        "ethereum-still-paid-once",
        "second call left the exact paid balance",
        async ctx => {
          Assert.strictEqual(
            await EthereumSyndicationTool.readLiqEthBalance(
              ctx,
              EmergencyStopScenario.ethereumAddress(ctx)
            ),
            ctx.outputs.assert(Constants.EthereumBefore) +
              Constants.Payout * Constants.EthereumScale
          )
        }
      )
    )
  }
}

/** Read-only identity helpers shared by Ethereum verifications. */
export namespace EmergencyStopScenario {
  /** Imported holder's native Ethereum address. */
  export function ethereumAddress(ctx: ClusterBuildContext): string {
    const address =
      Steps.registry.readMockSyndicationBonder(ctx).ethereum.address
    return address.startsWith("0x") ? address : `0x${address}`
  }
}
