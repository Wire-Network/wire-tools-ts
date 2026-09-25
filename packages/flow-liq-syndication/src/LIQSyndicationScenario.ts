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

const { SysioContractName } = SysioContracts
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
 * The depot's `sysio.msgch` dispatcher does NOT handle either type yet (unknown
 * types fall through its default), so the assertion is deliberately two-sided:
 * the attestations must circulate, AND the depot must keep advancing its epoch
 * while consuming envelopes that carry them. A depot that choked on an unknown
 * type would stall the epoch — the last phase is what catches that.
 *
 * 1. **SnapshotDepotEpoch** — record `current_epoch_index` BEFORE any write.
 * 2. **Syndicate** — map the liq token, fund the user, deposit for liqSOL, flip
 *    Launching → PostLaunch, `synd`, then prove `SYNDICATE_LIQ` reached an
 *    `OUTPOST_SOLANA_DEPOT` envelope.
 * 3. **ReportLiqYield** — snapshot the on-chain liq-yield accounting, donate
 *    bonus pool yield, crank `report_liq_yield` as a NON-admin, then prove the
 *    circulated `LIQ_YIELD` decodes to exactly the reported delta.
 * 4. **DepotAcceptsUnknownTypes** — `current_epoch_index` advances past the
 *    snapshot, so consensus kept closing epochs across both attestations.
 */
export class LIQSyndicationScenario extends FlowScenario {
  readonly name = "flow-liq-syndication"
  readonly description =
    "SYNDICATE_LIQ + LIQ_YIELD produced by the real liqsol_core paths circulate in an OPP envelope, and the depot keeps advancing its epoch"

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

    // ── 4. The depot kept advancing while carrying the unknown types ──
    ClusterBuildPhase.create(
      cluster,
      "DepotAcceptsUnknownTypes",
      "The depot advances its epoch past the snapshot — envelopes carrying types its dispatcher does not know are accepted, not fatal"
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
}
