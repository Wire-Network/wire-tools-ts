import Assert from "node:assert"
import { NodeOwnerTier, OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildContext,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  FlowScenario,
  Report,
  Steps,
  WireOperatorProvisioningTool,
  matchesProtoEnum,
  pollUntil,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { SlashingScenarioConstants as Constants } from "./SlashingScenarioConstants.js"
import { SlashingScenarioDisputeSteps as DisputeSteps } from "./steps/SlashingScenarioDisputeSteps.js"

const { SysioContractName, SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report

/** The WIRE chain is producing blocks (basic cluster health). */
async function verifyChainProducing(ctx: ClusterBuildContext): Promise<void> {
  Assert.ok(
    Number((await ctx.wire.getInfo()).head_block_num) > 0,
    "WIRE chain is not producing blocks"
  )
}

/**
 * The Tier-1 electorate registered — `nodecount.t1_count` covers the voters
 * (each `nodeownreg` inline-bumps it; `chkdispute` reads it as the quorum N).
 */
async function verifyElectorateRegistered(
  ctx: ClusterBuildContext
): Promise<void> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.system)
    .tables.nodecount.query({ limit: 1 })
  Assert.ok(rows.length === 1, "nodecount singleton row missing")
  Assert.ok(
    Number(rows[0].t1_count) >= Constants.Tier1VoterNames.length,
    `nodecount.t1_count ${rows[0].t1_count} < ${Constants.Tier1VoterNames.length} registered voters`
  )
}

/** `chalg::opendispute` inline-called `epoch::pause` — the epoch is paused. */
async function verifyEpochPaused(ctx: ClusterBuildContext): Promise<void> {
  Assert.ok(
    await DisputeSteps.epochPaused(ctx),
    "chalg::opendispute must inline-pause the epoch"
  )
}

/** `resolvedisp` dispatched the winner; `chkdispute` unpauses the epoch. */
async function verifyEpochUnpauses(ctx: ClusterBuildContext): Promise<void> {
  await pollUntil(
    "epoch unpauses after resolution",
    async () => (await DisputeSteps.epochPaused(ctx)) === false,
    Constants.unpauseDeadlineMs(),
    Constants.LongPollIntervalMs
  )
}

/** The 3 dispute operators are exactly the active batch-operator group. */
async function verifySoleActiveGroup(ctx: ClusterBuildContext): Promise<void> {
  await pollUntil(
    "the 3 dispute operators are exactly the active batch-op group",
    () => DisputeSteps.disputeOperatorsOwnGroup(ctx),
    Constants.groupDeadlineMs(),
    Constants.LongPollIntervalMs
  )
}

/** The epoch settles (frozen) on the dispute-operators-owned post-swap epoch. */
async function verifySettledDisputeEpoch(
  ctx: ClusterBuildContext
): Promise<void> {
  await DisputeSteps.settleOnDisputeEpoch(ctx)
}

/** The canonical deliverer must NOT be slashed (may be ACTIVE/UNKNOWN, never SLASHED). */
async function verifyCanonicalNotSlashed(
  ctx: ClusterBuildContext
): Promise<void> {
  const row = await DisputeSteps.readOperator(ctx, Constants.CanonicalOperator)
  Assert.ok(
    row != null,
    `operator row missing for ${Constants.CanonicalOperator}`
  )
  Assert.ok(
    !matchesProtoEnum(
      row.status,
      SysioOpregOperatorstatus,
      SysioOpregOperatorstatus.OPERATOR_STATUS_SLASHED
    ),
    `${Constants.CanonicalOperator} (canonical deliverer) must not be SLASHED`
  )
}

/**
 * Batch Operator Slashing via the OPP envelope dispute vote.
 *
 * Exercises the full dispute-vote path end-to-end (the in-repo C++ suite
 * `contracts/tests/sysio.dispute_tests.cpp` covers the chalg actions in
 * isolation; this flow covers the trigger + slash economics against a live
 * cluster):
 *
 * 1. Three batch operators deliver THREE DISTINCT envelope versions for one
 *    (outpost, epoch) with no majority, past the epoch boundary.
 *    `sysio.msgch::evalcons` detects the 3-way split and inline-calls
 *    `sysio.chalg::opendispute`, which pauses the epoch.
 * 2. Tier-1 node owners vote (`sysio.chalg::votedispute`) for the canonical
 *    checksum.
 * 3. A permissionless crank (`sysio.chalg::chkdispute`) tallies the votes;
 *    once a checksum reaches floor(N/2)+1 of the live Tier-1 count it wins.
 *    chkdispute records the winner, dispatches the winning envelope via
 *    `sysio.msgch::resolvedisp`, and unpauses the epoch.
 * 4. On the next `advance`, every operator that delivered a NON-canonical
 *    checksum is slashed (`sysio.opreg::slash`, bond → LP, status SLASHED).
 *    The operator that delivered the canonical checksum is NOT slashed.
 *
 * To force a 3-way split, the three dispute operators are provisioned SBP-less
 * and made the sole active batch-op group, so their step-pushed deliveries are
 * the only ones the depot sees for the contested (outpost, epoch). Each
 * divergent delivery carries a distinct, epoch-matching OPP Envelope built with
 * the `@wireio/opp-typescript-models` Envelope encoder, so the depot's
 * trustless `sha256(data)` yields three distinct candidate checksums and
 * `opendispute` fires.
 */
export class SlashingScenario extends FlowScenario {
  readonly name = "flow-batch-operator-slashing"
  readonly description =
    "Three divergent batch-operator deliveries open a dispute; Tier-1 owners vote the canonical checksum; non-canonical deliverers are slashed"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    // Enough bootstrapped batch ops to keep the rest of the network healthy
    // while the dispute operators drive the contested outpost.
    batchOperatorCount: Constants.BootstrapBatchOperatorCount,
    // Miss-ladder termination effectively disabled — see the constants' JSDoc.
    terminateMaxConsecutiveMisses: Constants.TerminateMaxConsecutiveMisses,
    terminateMaxPercentMisses24h: Constants.TerminateMaxPercentMisses24h
  }

  plan(cluster: ClusterBuild): void {
    const activeStepOptions = {
        timeoutMs: Constants.activeDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      groupStepOptions = {
        timeoutMs: Constants.groupDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      settleStepOptions = {
        timeoutMs: Constants.settleDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      stageStepOptions = {
        timeoutMs:
          Constants.boundaryDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      disputeOpenStepOptions = {
        timeoutMs:
          Constants.disputeOpenDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      resolveStepOptions = {
        timeoutMs:
          Constants.resolveDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      unpauseStepOptions = {
        timeoutMs:
          Constants.unpauseDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      slashStepOptions = {
        timeoutMs: Constants.slashDeadlineMs() + Constants.PollDeadlineBufferMs
      }

    // ── 1. SetupDispute — 3 T1 voters, 3 SBP-less dispute ops, 1-group/3-op epoch ──
    const setup = ClusterBuildPhaseGroup.create(
      cluster,
      "SetupDispute",
      "Provision the Tier-1 electorate + the 3 SBP-less dispute operators; reshape to a single 3-operator group"
    )

    ClusterBuildPhase.create(
      setup,
      "ChainHealth",
      "The WIRE chain is producing blocks"
    ).push(
      verifyStep(
        Actor.Sysio,
        "chain-producing",
        "WIRE chain is producing blocks",
        verifyChainProducing
      )
    )

    // The dispute electorate: each owner is created with the shared dev K1 key
    // (so the flow can sign votes as any of them) and registered T1 via the same
    // path the NFT claim uses (newnameduser creates the account, nodeownreg
    // registers it + inline-bumps nodecount.t1_count — the N chkdispute reads).
    ClusterBuildPhase.create(
      setup,
      "ProvisionVoters",
      "Create + register the 3 Tier-1 voters (the dispute electorate)"
    ).push(
      ...Constants.Tier1VoterNames.flatMap(voter => [
        DisputeSteps.planNewnameduser(
          Actor.User,
          `create-${voter}`,
          `create Tier-1 voter account ${voter}`,
          {},
          voter,
          NodeOwnerTier.T1
        ),
        DisputeSteps.planNodeownreg(
          Actor.User,
          `register-${voter}`,
          `register ${voter} as a Tier-1 node owner`,
          {},
          voter,
          NodeOwnerTier.T1
        )
      ]),
      verifyStep(
        Actor.Sysio,
        "electorate-registered",
        "nodecount.t1_count covers the 3 registered voters",
        verifyElectorateRegistered
      )
    )

    // The 3 divergent-delivery operators, provisioned SBP-less (no daemon) and
    // non-bootstrapped via the ONE provisioning mechanism, so they never
    // auto-deliver — the flow pushes their deliveries by hand. With
    // `req_batchop_collat` empty (this flow does not set it), processbatch can
    // flip them ACTIVE with no collateral deposits.
    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      setup,
      "ProvisionDisputeOperators",
      "Provision the 3 SBP-less non-bootstrapped dispute batch operators",
      {},
      Constants.DisputeOperators.map((account, index) => ({
        account,
        type: OperatorType.BATCH,
        ethereumHdIndex: Constants.DisputeOperatorEthereumHdBase + index,
        isBootstrapped: false
      }))
    )

    // Reconfigure the epoch to ONE group of 3 and rebuild the groups so the
    // sole active batch-op group is exactly the 3 dispute ops. `schbatchgps`
    // sorts non-bootstrapped ops first, then by name, so the three
    // non-bootstrapped `dispop.*` fill the single group (the bootstrapped
    // harness ops sort after and fall outside it). `deliver` is gated to the
    // active group, so only these 3 can deliver — and being SBP-less, only when
    // the flow tells them to. `sysio.epoch@active` resolves to `sysio@active`
    // (the governance key loaded in kiod), so the flow can sign setconfig /
    // schbatchgps.
    ClusterBuildPhase.create(
      setup,
      "ReshapeSchedule",
      "One group of exactly the 3 dispute operators"
    ).push(
      Steps.contracts.sysio.epoch.planSetconfig(
        Actor.Sysio,
        "one-group-of-three",
        "reconfigure the epoch to a single 3-operator group",
        {},
        {
          epoch_duration_sec: Constants.EpochDurationSec,
          operators_per_epoch: Constants.DisputeOperators.length,
          batch_operator_minimum_active: Constants.DisputeOperators.length,
          batch_op_groups: Constants.DisputeBatchOperatorGroupCount,
          epoch_retention_envelope_log_count:
            Constants.EpochRetentionEnvelopeLogCount
        }
      ),
      ...Constants.DisputeOperators.map(operator =>
        DisputeSteps.planProcessbatch(
          Actor.Sysio,
          `force-eligible-${operator}`,
          `flip ${operator} eligible via opreg::processbatch`,
          {},
          { account: operator, was_eligible: false, is_eligible: true }
        )
      ),
      ...Constants.DisputeOperators.map(operator =>
        DisputeSteps.planAwaitOperatorActive(
          Actor.Sysio,
          `${operator}-active`,
          `${operator} flips OPERATOR_STATUS_ACTIVE`,
          activeStepOptions,
          operator
        )
      ),
      Steps.contracts.sysio.epoch.planSchbatchgps(
        Actor.Sysio,
        "rebuild-groups",
        "rebuild the batch-operator groups around the ACTIVE dispute operators",
        {}
      ),
      verifyStep(
        Actor.Sysio,
        "sole-active-group",
        "the 3 dispute operators are exactly the active batch-operator group",
        verifySoleActiveGroup,
        groupStepOptions
      )
    )

    // Wait for the epoch to settle (freeze) on the first fully-post-swap epoch —
    // only the SBP-less dispute ops are elected there, so its contested bucket
    // is EMPTY of the bootstrap ops' pre-swap deliveries. Staging the divergent
    // split there opens a genuine dispute instead of colliding with the
    // bootstrap majority that pollutes the genesis epoch.
    ClusterBuildPhase.create(
      setup,
      "SettleDisputeEpoch",
      "The epoch settles (frozen) on the dispute-operators-owned epoch"
    ).push(
      verifyStep(
        Actor.Sysio,
        "settle-frozen-epoch",
        "epoch index freezes while the dispute operators own the active group",
        verifySettledDisputeEpoch,
        settleStepOptions
      )
    )

    // ── 2. InjectDivergent — 3-way checksum split on the contested outpost ──
    const inject = ClusterBuildPhaseGroup.create(
      cluster,
      "InjectDivergent",
      "3 batch operators each deliver the consensus SOLANA envelope + a distinct ETHEREUM envelope → 3-way checksum split"
    )

    // A dispute opens ONLY from deliver's inline evalcons, and only when that
    // deliver lands with now >= next_epoch_start (chkcons does NOT open
    // disputes) — so wait past the frozen epoch's boundary first, capturing the
    // contested epoch index for every subsequent deliver / dispute read.
    ClusterBuildPhase.create(
      inject,
      "StageContestedEpoch",
      "Chain clock passes the frozen epoch's boundary; the contested epoch is captured"
    ).push(
      DisputeSteps.planStageContestedEpoch(
        Actor.Sysio,
        "stage-contested-epoch",
        "chain head-block time passes next_epoch_start; capture the contested epoch",
        stageStepOptions
      )
    )

    // One phase per dispute operator (parallel), each holding two atomic
    // deliver steps run in order: the IDENTICAL consensus envelope for the
    // non-contested outpost (SOLANA — so it reaches Option-A consensus for the
    // contested epoch; the post-resolution advance where the slash runs
    // requires EVERY active outpost at epoch consensus), then the operator's
    // DISTINCT divergent envelope for the contested outpost (ETHEREUM). Each
    // operator's SOLANA deliver strictly precedes its ETHEREUM deliver, so all
    // three consensus deliveries land before the 3rd divergent one can open the
    // dispute — the same ordering the depot saw from the original flow.
    const deliveries = ClusterBuildPhaseGroup.create(
      inject,
      "DivergentDeliveries",
      "Each dispute operator delivers consensus SOLANA + its divergent ETHEREUM envelope",
      { parallel: true }
    )
    Constants.DisputeOperators.forEach((operator, index) => {
      ClusterBuildPhase.create(
        deliveries,
        `Deliver ${operator}`,
        `${operator} delivers consensus SOLANA + divergent ETHEREUM`
      ).push(
        DisputeSteps.planDeliver(
          Actor.BatchOperator,
          `${operator}-deliver-solana`,
          `${operator} delivers the consensus SOLANA envelope`,
          {},
          operator,
          Constants.NonContestedChainCode,
          Constants.ConsensusEnvelopeTag
        ),
        DisputeSteps.planDeliver(
          Actor.BatchOperator,
          `${operator}-deliver-ethereum`,
          `${operator} delivers its divergent ETHEREUM envelope (${Constants.EnvelopeTags[index]})`,
          {},
          operator,
          Constants.ContestedChainCode,
          Constants.EnvelopeTags[index]
        )
      )
    })

    ClusterBuildPhase.create(
      inject,
      "DisputeOpens",
      "The 3-way split opens a dispute and pauses the epoch"
    ).push(
      DisputeSteps.planAwaitDisputeOpened(
        Actor.Sysio,
        "dispute-opens",
        "an OPEN dispute row appears for the contested (outpost, epoch) with a candidate per operator",
        disputeOpenStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "epoch-paused",
        "chalg::opendispute inline-paused the epoch",
        verifyEpochPaused
      )
    )

    // ── 3. VoteAndResolve — Tier-1 vote → chkdispute resolves → unpause ──
    ClusterBuildPhase.create(
      cluster,
      "VoteAndResolve",
      "The 3 Tier-1 owners vote the canonical checksum; chkdispute resolves the dispute + unpauses"
    ).push(
      // All provisioned Tier-1 owners vote for the canonical checksum — 3 votes
      // clears the live quorum Q = floor(nodecount.t1_count/2)+1 (= 3 with the
      // 3 voters + the bootstrap owner wireno).
      ...Constants.Tier1VoterNames.map(voter =>
        DisputeSteps.planVotedispute(
          Actor.User,
          `vote-${voter}`,
          `${voter} votes the canonical checksum via sysio.chalg::votedispute`,
          {},
          voter
        )
      ),
      DisputeSteps.planAwaitDisputeResolved(
        Actor.Sysio,
        "dispute-resolves",
        "the dispute resolves to the canonical winner",
        resolveStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "epoch-unpauses",
        "the epoch unpauses after resolution",
        verifyEpochUnpauses,
        unpauseStepOptions
      )
    )

    // ── 4. SlashNonCanonical — losers SLASHED, winner untouched ──
    ClusterBuildPhase.create(
      cluster,
      "SlashNonCanonical",
      "Non-canonical deliverers flip SLASHED; the canonical deliverer does not"
    ).push(
      ...Constants.LosingOperators.map(operator =>
        DisputeSteps.planAwaitOperatorSlashed(
          Actor.Sysio,
          `${operator}-slashed`,
          `${operator} (non-canonical) becomes OPERATOR_STATUS_SLASHED`,
          slashStepOptions,
          operator
        )
      ),
      verifyStep(
        Actor.Sysio,
        "canonical-not-slashed",
        "the canonical deliverer is NOT slashed",
        verifyCanonicalNotSlashed
      )
    )
  }
}
