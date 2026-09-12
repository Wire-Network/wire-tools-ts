import Assert from "node:assert"
import { oppDebuggingPath } from "@wireio/debugging-shared"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  FlowScenario,
  ProtocolTiming,
  Report,
  containsLiqYield,
  containsSyndicateLiq,
  outputKey,
  pollUntil,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { LiqSyndicationScenarioConstants as Constants } from "./LiqSyndicationScenarioConstants.js"
import { LiqSyndicationScenarioEmitSteps as EmitSteps } from "./steps/index.js"

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
 * Liq syndication — the `simple_swap` attestation trio's harness-side proof
 * that the three NEW types circulate end-to-end without disturbing the depot.
 *
 * The depot's `sysio.msgch` dispatcher does NOT handle `SYNDICATE_LIQ` /
 * `LIQ_YIELD` yet (unknown types fall through its default), so the assertion is
 * deliberately two-sided: the attestations must reach an OPP envelope on the
 * outpost → depot edge, AND the depot must keep advancing its epoch while
 * consuming envelopes that carry them. A depot that choked on an unknown type
 * would stall the epoch — the third phase is what catches that.
 *
 * 1. **SnapshotDepotEpoch** — record `current_epoch_index` BEFORE any injection.
 * 2. **InjectSyndicateLiq** — one `add_attestation` write, then the artifact
 *    scan proves a `SYNDICATE_LIQ` tag reached an `OUTPOST_SOLANA_DEPOT` envelope.
 * 3. **InjectLiqYield** — the same for `LIQ_YIELD` on the shared liq sequence.
 * 4. **DepotAcceptsUnknownTypes** — `current_epoch_index` advances past the
 *    snapshot, so consensus kept closing epochs across both injections.
 */
export class LiqSyndicationScenario extends FlowScenario {
  readonly name = "flow-liq-syndication"
  readonly description =
    "SYNDICATE_LIQ + LIQ_YIELD injected on the Solana outpost circulate in an OPP envelope, and the depot keeps advancing its epoch"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount
  }

  plan(cluster: ClusterBuild): void {
    const emitStepOptions = { timeoutMs: Constants.EmitStepTimeoutMs },
      circulationStepOptions = {
        timeoutMs:
          Constants.CirculationTimeoutMs + ProtocolTiming.PollDeadlineBufferMs
      },
      epochAdvanceStepOptions = {
        timeoutMs:
          Constants.epochAdvanceDeadlineMs() + ProtocolTiming.PollDeadlineBufferMs
      }

    // ── 1. Snapshot the depot's epoch index BEFORE the injections ──
    ClusterBuildPhase.create(
      cluster,
      "SnapshotDepotEpoch",
      "Record the depot's current_epoch_index before any liq attestation is injected"
    ).push(
      verifyStep(
        Actor.Sysio,
        "snapshot-epoch-index",
        "record sysio.epoch::epochstate.current_epoch_index",
        async ctx => {
          ctx.outputs.set(
            LiqSyndicationScenario.EpochIndexBeforeKey,
            await readCurrentEpochIndex(ctx)
          )
        }
      )
    )

    // ── 2. SYNDICATE_LIQ reaches an outpost → depot envelope ──
    ClusterBuildPhase.create(
      cluster,
      "InjectSyndicateLiq",
      "Inject a SYNDICATE_LIQ on the Solana outpost; it circulates in an OPP envelope"
    ).push(
      EmitSteps.planSyndicateLiqEmit(
        Actor.SolanaOutpost,
        "emit-syndicate-liq",
        `enqueue SYNDICATE_LIQ for ${Constants.SyndicatedAmount} liqSOL base units (sequence ${Constants.SyndicateSequence})`,
        emitStepOptions,
        BigInt(Constants.SolanaChainCode),
        Constants.SyndicatedAmount,
        Constants.SyndicateSequence
      ),
      verifyStep(
        Actor.BatchOperator,
        "syndicate-liq-circulates",
        "SYNDICATE_LIQ appears in an OUTPOST_SOLANA_DEPOT envelope artifact",
        async ctx => {
          await pollUntil(
            "SYNDICATE_LIQ in an OUTPOST_SOLANA_DEPOT envelope",
            async () =>
              containsSyndicateLiq(oppDebuggingPath(ctx.config.clusterPath)),
            Constants.CirculationTimeoutMs,
            Constants.CirculationPollMs
          )
        },
        circulationStepOptions
      )
    )

    // ── 3. LIQ_YIELD reaches an outpost → depot envelope ──
    ClusterBuildPhase.create(
      cluster,
      "InjectLiqYield",
      "Inject a LIQ_YIELD on the Solana outpost; it circulates in an OPP envelope"
    ).push(
      EmitSteps.planLiqYieldEmit(
        Actor.SolanaOutpost,
        "emit-liq-yield",
        `enqueue LIQ_YIELD for ${Constants.ReportedYieldAmount} liqSOL base units (sequence ${Constants.LiqYieldSequence})`,
        emitStepOptions,
        BigInt(Constants.SolanaChainCode),
        Constants.ReportedYieldAmount,
        Constants.LiqYieldSequence,
        Constants.ReportedSolanaEpoch
      ),
      verifyStep(
        Actor.BatchOperator,
        "liq-yield-circulates",
        "LIQ_YIELD appears in an OUTPOST_SOLANA_DEPOT envelope artifact",
        async ctx => {
          await pollUntil(
            "LIQ_YIELD in an OUTPOST_SOLANA_DEPOT envelope",
            async () =>
              containsLiqYield(oppDebuggingPath(ctx.config.clusterPath)),
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
        "sysio.epoch::epochstate.current_epoch_index advances past the pre-injection snapshot",
        async ctx => {
          const before = ctx.outputs.assert(
            LiqSyndicationScenario.EpochIndexBeforeKey
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
export namespace LiqSyndicationScenario {
  /** `epochstate.current_epoch_index` snapshotted before the injections. */
  export const EpochIndexBeforeKey = outputKey<number>(
    "liqSyndication.epochIndexBefore",
    "the depot's current_epoch_index before any liq attestation was injected"
  )
}
