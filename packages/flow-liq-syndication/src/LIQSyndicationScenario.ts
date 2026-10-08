import Assert from "node:assert"

import { oppDebuggingPath } from "@wireio/debugging-shared"
import {
  AttestationType,
  DebugOutpostEndpointsType,
  LIQYield
} from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  FlowScenario,
  ProtocolTiming,
  Report,
  SolanaFundingTool,
  SolanaLiqSyndicationTool,
  WireState,
  Steps,
  SyndicationScenario,
  SyndicationUserSteps,
  Constants as HarnessConstants,
  WireSyndicationTool,
  SolanaOutpostBootstrapper,
  containsLIQYield,
  containsSyndicateLIQ,
  outputKey,
  pollUntil,
  readEnvelopeAttestations,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { LIQSyndicationScenarioConstants as Constants } from "./LIQSyndicationScenarioConstants.js"

const { SysioContractName, SysioSyndItemKind, SysioSyndChainkind } =
  SysioContracts
const { Actor } = Report

// ── reads (execute freely inside verify steps) ──────────────────────────────

/** The depot's `sysio.epoch::epochstate` singleton (a read, typed accessor). */
async function readEpochState(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioEpochEpochStateType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.epoch)
    .tables.epochstate.query({ limit: Constants.EpochStateQueryLimit })
  Assert.ok(
    rows.length >= 1,
    "sysio.epoch::epochstate has no row — did the bootstrap's EpochBootstrap run?"
  )
  return rows[0]
}

/** `epochstate.current_epoch_index` (a read — the depot-liveness metric). */
async function readCurrentEpochIndex(
  ctx: ClusterBuildContext
): Promise<number> {
  return (await readEpochState(ctx)).current_epoch_index
}

/**
 * Every `LIQYield` the Solana outpost has published into an OUTPOST_SOLANA_DEPOT
 * envelope, decoded by its OWN generated message class (a read over the
 * `data/opp-debugging/` artifacts).
 */
async function readCirculatedLIQYields(
  ctx: ClusterBuildContext
): Promise<LIQYield[]> {
  return (
    await readEnvelopeAttestations(
      oppDebuggingPath(ctx.config.clusterPath),
      DebugOutpostEndpointsType.OUTPOST_SOLANA_DEPOT,
      AttestationType.LIQ_YIELD
    )
  ).map(payload => LIQYield.fromBinary(payload))
}

/**
 * LIQ syndication — the `simple_swap` liq attestations driven through the REAL
 * `liqsol_core` paths, end-to-end, with nothing injected.
 *
 * A user deposits SOL for liqSOL, the admin flips the outpost to PostLaunch,
 * the user syndicates — and `synd` itself queues `SYNDICATE_LIQ`. A
 * permissionless donation then credits the syndicated pool and the
 * permissionless `report_liq_yield` crank queues `LIQ_YIELD` for the delta
 * above its watermark. Both must reach an outpost → depot envelope.
 *
 * After proving the unbonded intake is held, sysio explicitly resolves it VALID.
 * The normal queue releases the principal and authenticated linking delivers it
 * to the destination wallet. Yield is separately resolved into pending yield.
 * Native contract tests compare this governance shortcut against real providers.
 */
export class LIQSyndicationScenario extends FlowScenario {
  readonly name = "flow-liq-syndication"
  readonly description =
    "Real liqsol syndication reaches the destination wallet; reported yield is released on the depot"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount
  }

  plan(cluster: ClusterBuild): void {
    const writeStepOptions = { timeoutMs: Constants.OutpostWriteTimeoutMs },
      circulationStepOptions = {
        timeoutMs:
          Constants.CirculationTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
      },
      epochAdvanceStepOptions = {
        timeoutMs:
          Constants.epochAdvanceDeadlineMs() +
          ProtocolTiming.PollDeadlineBufferMs
      }

    // ── 1. Snapshot the depot's epoch index BEFORE the syndication ──
    ClusterBuildPhase.create(
      cluster,
      "SnapshotDepotEpoch",
      "Record the depot's current_epoch_index before any liq attestation is produced"
    ).push(
      verifyStep(
        Actor.Sysio,
        "snapshot-epoch-index",
        "record sysio.epoch::epochstate.current_epoch_index",
        async ctx => {
          ctx.outputs.set(
            LIQSyndicationScenario.EpochIndexBeforeKey,
            await readCurrentEpochIndex(ctx)
          )
        }
      )
    )

    // ── 2. A real deposit + syndication emits SYNDICATE_LIQ ──
    ClusterBuildPhase.create(
      cluster,
      "Syndicate",
      "A user deposits SOL for liqSOL and syndicates it PostLaunch; liqsol_core queues SYNDICATE_LIQ"
    ).push(
      // FIRST, and a read: the phase's writes are all one-way, so a cluster
      // this scenario has already run against must be refused before it spends
      // one — not after a 5 SOL deposit has already landed.
      verifyStep(
        Actor.SolanaOutpost,
        "outpost-is-pre-launch",
        "the outpost GlobalState is still PreLaunch — the state this scenario transitions from",
        async ctx => {
          const current = await SolanaLiqSyndicationTool.readWireState(ctx)
          Assert.strictEqual(
            current,
            WireState.preLaunch,
            `the outpost is in ${current}, not ${WireState.preLaunch} — this scenario drives ` +
              "PreLaunch -> Launching -> PostLaunch and PostLaunch is TERMINAL, so it is " +
              "single-shot per cluster (use a fresh --cluster-path)"
          )
        }
      ),
      SolanaLiqSyndicationTool.planSetLiqTokenAddress(
        Actor.SolanaOutpost,
        "map-liq-token",
        `bind the liqSOL mint to depot token code ${Constants.LIQTokenCode} on the outpost config`,
        writeStepOptions,
        Constants.LIQTokenCode
      ),
      SolanaFundingTool.planKeypairAirdrop(
        Actor.User,
        "airdrop-user",
        `top the syndicating user up to ${Constants.UserFloorLamports} lamports`,
        writeStepOptions,
        Constants.UserKeypairName,
        Constants.UserFloorLamports
      ),
      SolanaLiqSyndicationTool.planDepositForLiqsol(
        Actor.User,
        "deposit-for-liqsol",
        `deposit ${Constants.DepositLamports} lamports for liqSOL 1:1`,
        writeStepOptions,
        Constants.UserKeypairName,
        Constants.DepositLamports
      ),
      SolanaLiqSyndicationTool.planSetWireState(
        Actor.SolanaOutpost,
        "set-wire-state-launching",
        "move the outpost GlobalState to Launching",
        writeStepOptions,
        WireState.launching
      ),
      SolanaLiqSyndicationTool.planSetWireState(
        Actor.SolanaOutpost,
        "set-wire-state-post-launch",
        "move the outpost GlobalState to PostLaunch (the depot becomes the syndication ledger)",
        writeStepOptions,
        WireState.postLaunch
      ),
      SolanaLiqSyndicationTool.planSynd(
        Actor.User,
        "syndicate-liqsol",
        `syndicate ${Constants.SyndicateAmount} liqSOL base units into the outpost-owned pool`,
        writeStepOptions,
        Constants.UserKeypairName,
        Constants.SyndicateAmount
      ),
      verifyStep(
        Actor.BatchOperator,
        "syndicate-liq-circulates",
        "SYNDICATE_LIQ appears in an OUTPOST_SOLANA_DEPOT envelope artifact",
        async ctx => {
          await pollUntil(
            "SYNDICATE_LIQ in an OUTPOST_SOLANA_DEPOT envelope",
            async () =>
              containsSyndicateLIQ(oppDebuggingPath(ctx.config.clusterPath)),
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
        },
        circulationStepOptions
      )
    )

    ClusterBuildPhase.create(
      cluster,
      "HeldWithoutBonder",
      "The depot holds the envelope's items without crediting shadow"
    ).push(
      verifyStep(
        Actor.Sysio,
        "syndication-remains-held",
        "the closed envelope is WAITING or REQUESTED and the unlinked user has no shadow",
        async ctx => {
          const pubkey = SolanaFundingTool.loadKeypair(
            ctx.config.dataPath,
            Constants.UserKeypairName
          )
            .publicKey.toBuffer()
            .toString("hex")
          await pollUntil(
            "held syndication envelope",
            async () => {
              const envelope = await WireSyndicationTool.readHeldEnvelope(
                ctx,
                SolanaOutpostBootstrapper.SolanaChainCodename,
                Constants.LIQTokenCodename,
                SysioSyndItemKind.SYNDICATION,
                Constants.SyndicateAmount,
                pubkey
              )
              if (!envelope) return false
              ctx.outputs.set(
                LIQSyndicationScenario.SyndicationEpochKey,
                envelope.epoch_index
              )
              return true
            },
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
          Assert.strictEqual(
            await WireSyndicationTool.readParked(
              ctx,
              Constants.LIQTokenCodename,
              SysioSyndChainkind.CHAIN_KIND_SVM,
              pubkey
            ),
            undefined
          )
          // Intake mints shadow into sysio.synd's custody. The full held item
          // and absent parked credit prove this unlinked user's funds have
          // not been released; total token supply is not a user balance.
        },
        circulationStepOptions
      )
    )

    ClusterBuildPhase.create(
      cluster,
      "DeliverSyndication",
      "Resolve intake and deliver all principal to the destination wallet"
    ).push(
      Steps.account.planCreateKeyed(
        Actor.User,
        "create-destination",
        "create the WIRE destination",
        SyndicationScenario.WriteOptions,
        Constants.UserAccount,
        HarnessConstants.DEV_K1_PUBLIC_KEY
      ),
      SyndicationUserSteps.planResourcePolicy(
        Actor.User,
        "destination-resources",
        "allocate destination resources",
        SyndicationScenario.WriteOptions,
        SyndicationScenario.resourcePolicy(Constants.UserAccount)
      ),
      WireSyndicationTool.planResolveEnvelope(
        Actor.Sysio,
        "resolve-syndication",
        "sysio validates the custody report",
        circulationStepOptions,
        SolanaOutpostBootstrapper.SolanaChainCodename,
        Constants.LIQTokenCodename,
        LIQSyndicationScenario.SyndicationEpochKey
      ),
      Steps.contracts.sysio.synd.planCrank(
        Actor.User,
        "release-syndication",
        "release resolved principal through the normal queue",
        SyndicationScenario.WriteOptions,
        { limit: SyndicationScenario.CrankLimit },
        Constants.UserAccount
      ),
      SyndicationUserSteps.planLinkSolanaKey(
        Actor.User,
        "link-destination",
        "authenticate the wallet and sweep parked principal",
        SyndicationScenario.WriteOptions,
        Constants.UserAccount,
        Constants.UserKeypairName
      ),
      verifyStep(
        Actor.User,
        "syndication-in-wallet",
        "all syndicated principal is liquid in the destination wallet",
        async ctx => {
          await pollUntil(
            "principal delivered to destination",
            async () =>
              (await SyndicationScenario.readBalance(
                ctx,
                Constants.UserAccount
              )) === Constants.SyndicateAmount,
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
          Assert.strictEqual(
            await WireSyndicationTool.readParked(
              ctx,
              Constants.LIQTokenCodename,
              SysioSyndChainkind.CHAIN_KIND_SVM,
              SolanaFundingTool.loadKeypair(
                ctx.config.dataPath,
                Constants.UserKeypairName
              )
                .publicKey.toBuffer()
                .toString("hex")
            ),
            undefined
          )
        },
        circulationStepOptions
      )
    )

    // ── 3. A real donation + crank emits LIQ_YIELD for the reported delta ──
    ClusterBuildPhase.create(
      cluster,
      "ReportLiqYield",
      "Bonus pool yield is donated and the permissionless crank queues LIQ_YIELD for the delta above the watermark"
    ).push(
      verifyStep(
        Actor.SolanaOutpost,
        "snapshot-liq-yield-state",
        "record GlobalState's liq-yield watermark + sequence before the donation",
        async ctx => {
          ctx.outputs.set(
            LIQSyndicationScenario.LiqYieldStateBeforeKey,
            await SolanaLiqSyndicationTool.readLiqYieldState(ctx)
          )
        }
      ),
      SolanaLiqSyndicationTool.planInjectBonusSyndYield(
        Actor.SolanaOutpost,
        "inject-bonus-synd-yield",
        `donate ${Constants.BonusYieldLamports} lamports of bonus yield to the syndicated pool`,
        writeStepOptions,
        SolanaFundingTool.DeployerKeypairName,
        Constants.BonusYieldLamports
      ),
      // The cranker is the USER, not the admin: `report_liq_yield`'s `cranker`
      // is an unconstrained signer, so driving it from a non-admin identity is
      // part of what this flow proves.
      SolanaLiqSyndicationTool.planReportLiqYield(
        Actor.User,
        "report-liq-yield",
        "crank report_liq_yield as a non-admin signer",
        writeStepOptions,
        Constants.UserKeypairName
      ),
      verifyStep(
        Actor.BatchOperator,
        "liq-yield-circulates",
        "the circulated LIQ_YIELD decodes to exactly the delta report_liq_yield reported",
        async ctx => {
          const before = ctx.outputs.assert(
              LIQSyndicationScenario.LiqYieldStateBeforeKey
            ),
            after = await SolanaLiqSyndicationTool.readLiqYieldState(ctx),
            reportedAmount = after.liqYieldReported - before.liqYieldReported
          Assert.ok(
            reportedAmount >= Constants.BonusYieldLamports,
            `report_liq_yield advanced the watermark by ${reportedAmount}, which is less than the ` +
              `${Constants.BonusYieldLamports} lamports donated — the donation was not claimed`
          )
          Assert.strictEqual(
            after.liqSequence - before.liqSequence,
            1n,
            "report_liq_yield must consume exactly one value of the shared liq sequence"
          )
          await pollUntil(
            `LIQ_YIELD for ${reportedAmount} (sequence ${after.liqSequence}) in an OUTPOST_SOLANA_DEPOT envelope`,
            async () =>
              containsLIQYield(oppDebuggingPath(ctx.config.clusterPath)) &&
              (await readCirculatedLIQYields(ctx)).some(
                report =>
                  report.sequence === after.liqSequence &&
                  report.chainCode === Constants.SolanaChainCode &&
                  report.amount?.tokenCode === Constants.LIQTokenCode &&
                  report.amount?.amount === reportedAmount
              ),
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
        },
        circulationStepOptions
      )
    )

    ClusterBuildPhase.create(
      cluster,
      "ReleaseReportedYield",
      "Resolve reported yield into the depot yield queue"
    ).push(
      verifyStep(
        Actor.Sysio,
        "yield-intake",
        "capture the held yield envelope",
        async ctx => {
          const before = ctx.outputs.assert(
              LIQSyndicationScenario.LiqYieldStateBeforeKey
            ),
            after = await SolanaLiqSyndicationTool.readLiqYieldState(ctx),
            amount = after.liqYieldReported - before.liqYieldReported
          ctx.outputs.set(LIQSyndicationScenario.ReportedYieldKey, amount)
          await pollUntil(
            "reported yield intake",
            async () => {
              const envelope = await WireSyndicationTool.readHeldEnvelope(
                ctx,
                SolanaOutpostBootstrapper.SolanaChainCodename,
                Constants.LIQTokenCodename,
                SysioSyndItemKind.YIELD,
                amount
              )
              if (!envelope) return false
              ctx.outputs.set(
                LIQSyndicationScenario.YieldEpochKey,
                envelope.epoch_index
              )
              return true
            },
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
        },
        circulationStepOptions
      ),
      WireSyndicationTool.planResolveEnvelope(
        Actor.Sysio,
        "resolve-yield",
        "sysio validates the reported custody yield",
        circulationStepOptions,
        SolanaOutpostBootstrapper.SolanaChainCodename,
        Constants.LIQTokenCodename,
        LIQSyndicationScenario.YieldEpochKey
      ),
      Steps.contracts.sysio.synd.planCrank(
        Actor.User,
        "release-yield",
        "release yield through the normal queue",
        SyndicationScenario.WriteOptions,
        { limit: SyndicationScenario.CrankLimit },
        Constants.UserAccount
      ),
      verifyStep(
        Actor.Sysio,
        "yield-released",
        "reported yield is fully released and principal remains in the wallet",
        async ctx => {
          const envelope = await WireSyndicationTool.readEnvelope(
            ctx,
            SolanaOutpostBootstrapper.SolanaChainCodename,
            Constants.LIQTokenCodename,
            ctx.outputs.assert(LIQSyndicationScenario.YieldEpochKey)
          )
          Assert.strictEqual(
            BigInt(envelope.released),
            BigInt(envelope.synd_total) + BigInt(envelope.yield_total)
          )
          Assert.strictEqual(
            await SyndicationScenario.readBalance(ctx, Constants.UserAccount),
            Constants.SyndicateAmount
          )
        }
      )
    )

    // ── 4. The depot kept advancing while carrying both liq types ──
    ClusterBuildPhase.create(
      cluster,
      "DepotKeepsAdvancing",
      "The depot advances its epoch past the snapshot — envelopes carrying the liq attestations are consumed, never fatal"
    ).push(
      verifyStep(
        Actor.Sysio,
        "epoch-index-advances",
        "sysio.epoch::epochstate.current_epoch_index advances past the pre-syndication snapshot",
        async ctx => {
          const before = ctx.outputs.assert(
            LIQSyndicationScenario.EpochIndexBeforeKey
          )
          await pollUntil(
            `current_epoch_index advances past ${before}`,
            async () => (await readCurrentEpochIndex(ctx)) > before,
            Constants.epochAdvanceDeadlineMs(),
            Constants.EpochAdvancePollMs
          )
        },
        epochAdvanceStepOptions
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "VerifySolvency",
      "The flow leaves the emergency cord clear and no mismatch"
    ).push(
      WireSyndicationTool.planVerifyHealthy(
        Actor.Sysio,
        "cord-clear-no-mismatch",
        "cord clear and mismatch empty",
        {}
      )
    )
  }
}

/** Typed cross-step output keys for the liq-syndication scenario. */
export namespace LIQSyndicationScenario {
  /** `epochstate.current_epoch_index` snapshotted before the syndication. */
  export const EpochIndexBeforeKey = outputKey<number>(
    "LIQSyndicationScenario.epochIndexBefore",
    "the depot's current_epoch_index before any liq attestation was produced"
  )
  /** `GlobalState`'s liq-yield accounting snapshotted before the bonus donation. */
  export const LiqYieldStateBeforeKey =
    outputKey<SolanaLiqSyndicationTool.LiqYieldState>(
      "LIQSyndicationScenario.liqYieldStateBefore",
      "the outpost's liq-yield watermark + sequence before the bonus-yield donation"
    )
  /** Runtime envelope identities used by explicit governance settlement. */
  export const SyndicationEpochKey = outputKey<number>(
    "liq-syndication.principalEpoch",
    "principal envelope"
  )
  export const YieldEpochKey = outputKey<number>(
    "liq-syndication.yieldEpoch",
    "yield envelope"
  )
  export const ReportedYieldKey = outputKey<bigint>(
    "liq-syndication.reportedYield",
    "reported yield amount"
  )
}
