import Assert from "node:assert"
import { NodeOwnerTier, OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildContext,
  ClusterBuildDefaults,
  ClusterBuildPhase,
  ClusterBuildPhaseGroup,
  FlowScenario,
  NodeConfig,
  Report,
  Steps,
  WireEconomicClockTool,
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
  Assert.strictEqual(
    Number(rows[0].t1_count),
    Constants.Tier1ElectorateNames.length,
    "nodecount.t1_count is not the flow's registered electorate — the dispute quorum depends on it"
  )
}

/**
 * `chalg::opendispute` inline-called `epoch::pause(chain)` — the contested chain's epoch is
 * paused, and the other outpost chain's is not: a dispute pauses only its own chain.
 */
async function verifyEpochPaused(ctx: ClusterBuildContext): Promise<void> {
  Assert.ok(
    await DisputeSteps.epochPaused(ctx),
    `chalg::opendispute must inline-pause the ${Constants.ContestedChain} epoch`
  )
  Assert.ok(
    !(await DisputeSteps.epochPaused(ctx, Constants.RunningChain)),
    `the ${Constants.ContestedChain} dispute must not pause the ${Constants.RunningChain} epoch`
  )
}

/** `resolvedisp` dispatched the winner; `chkdispute` unpauses the contested chain's epoch. */
async function verifyEpochUnpauses(ctx: ClusterBuildContext): Promise<void> {
  await pollUntil(
    `the ${Constants.ContestedChain} epoch unpauses after resolution`,
    async () => (await DisputeSteps.epochPaused(ctx)) === false,
    Constants.unpauseDeadlineMs(),
    Constants.LongPollIntervalMs
  )
}

/** The contested chain's epoch settles (frozen) on the epoch the dispute operators own. */
async function verifySettledDisputeEpoch(
  ctx: ClusterBuildContext
): Promise<void> {
  await DisputeSteps.settleOnDisputeEpoch(ctx)
}

/**
 * No delivery is recorded for the contested (outpost, epoch) yet, so the divergent
 * deliveries are the only candidates `sysio.msgch::evalcons` tallies for it.
 */
async function verifyContestedBucketEmpty(
  ctx: ClusterBuildContext
): Promise<void> {
  const epoch = ctx.outputs.assert(DisputeSteps.ContestedEpochKey),
    bucket = DisputeSteps.outpostEpochEnvelopes(
      await DisputeSteps.readEnvelopes(ctx),
      Constants.ContestedChain,
      epoch
    )
  Assert.strictEqual(
    bucket.length,
    0,
    `the ${Constants.ContestedChain} epoch ${epoch} already holds deliveries from ${JSON.stringify(bucket.map(row => row.batch_op_name))}`
  )
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
 *    (outpost, epoch) with no majority, past the chain's epoch boundary.
 *    `sysio.msgch::evalcons` detects the 3-way split and inline-calls
 *    `sysio.chalg::opendispute`, which pauses that chain's epoch only.
 *    While the dispute is open the economic clock keeps opening epochs — before
 *    and after every batch-operator relay is stopped and restarted — and the
 *    contested chain's consensus stays paused at the contested epoch.
 * 2. Tier-1 node owners vote (`sysio.chalg::votedispute`) for the canonical
 *    checksum.
 * 3. A permissionless crank (`sysio.chalg::chkdispute`) tallies the votes;
 *    once a checksum reaches floor(N/2)+1 of the live Tier-1 count it wins.
 *    chkdispute records the winner, dispatches the winning envelope via
 *    `sysio.msgch::resolvedisp`, and unpauses the chain's epoch.
 * 4. On the chain's next `advance`, every operator that delivered a NON-canonical
 *    checksum is slashed (`sysio.opreg::slash`, bond → LP, status SLASHED).
 *    The operator that delivered the canonical checksum is NOT slashed.
 *
 * To force a 3-way split, the three dispute operators are provisioned SBP-less,
 * serving the contested chain only, and flipped ACTIVE; the chain's next natural
 * advances seat them as its sole active batch-op group, so their step-pushed
 * deliveries are the only ones the depot sees for the contested (outpost, epoch).
 * The other chain's schedule keeps the bootstrapped operators, whose relays keep
 * it advancing throughout. Each
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
    economicEpochDurationSec: Constants.EconomicEpochDurationSec,
    // Enough bootstrapped batch ops to keep the rest of the network healthy
    // while the dispute operators drive the contested outpost.
    batchOperatorCount: Constants.BootstrapBatchOperatorCount,
    // Two groups (the depot's floor) of exactly DisputeOperators.length per
    // chain, set at bootstrap and never changed mid-run. Every advance draws the
    // new tail group from the chain's pool, so the contested chain's advance
    // after the dispute operators turn ACTIVE seats exactly them as the tail,
    // on duty from the advance after.
    operatorsPerEpoch: Constants.DisputeOperators.length,
    batchOpGroups: Constants.DisputeBatchOperatorGroupCount,
    // The dispute references the contested epoch's envelope log ~16 epochs later
    // (vote + tally + resolve + slash propagation), so retention must outlast it.
    epochRetentionEnvelopeLogCount: Constants.EpochRetentionEnvelopeLogCount,
    // Loosest VALID termination thresholds — see the constants' JSDoc.
    terminateMaxConsecutiveMisses: Constants.TerminateMaxConsecutiveMisses,
    terminateMaxPercentMisses24h: ClusterBuildDefaults.MaxTerminateMaxPercentMisses24h,
    terminateMinimumPercentSamples: ClusterBuildDefaults.MaxTerminateMinimumPercentSamples
  }

  plan(cluster: ClusterBuild): void {
    const headroomStepOptions = {
        timeoutMs:
          Constants.activationHeadroomDeadlineMs() +
          Constants.PollDeadlineBufferMs
      },
      activeStepOptions = {
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

    // ── 1. SetupDispute — 3 T1 voters, 3 SBP-less dispute ops, 2-group/3-op epoch ──
    const setup = ClusterBuildPhaseGroup.create(
      cluster,
      "SetupDispute",
      `Provision the Tier-1 electorate + the 3 SBP-less dispute operators; the ${Constants.ContestedChain} advances seat them as its active group`
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
    // path the NFT claim uses (nodeownreg creates and registers the account,
    // then inline-bumps nodecount.t1_count — the N chkdispute reads).
    ClusterBuildPhase.create(
      setup,
      "ProvisionVoters",
      "Create + register the 4 Tier-1 node owners of the dispute electorate (3 voters, 1 abstainer)"
    ).push(
      ...Constants.Tier1ElectorateNames.map(voter =>
        DisputeSteps.planNodeownreg(
          Actor.User,
          `register-${voter}`,
          `register ${voter} as a Tier-1 node owner`,
          {},
          voter,
          NodeOwnerTier.T1
        )
      ),
      verifyStep(
        Actor.Sysio,
        "electorate-registered",
        "nodecount.t1_count covers the 4 registered node owners",
        verifyElectorateRegistered
      )
    )

    // The 3 divergent-delivery operators, provisioned SBP-less (no daemon) and
    // non-bootstrapped via the ONE provisioning mechanism, so they never
    // auto-deliver — the flow pushes their deliveries by hand. They join the
    // contested chain only, so the other chain never seats them. With
    // `req_batchop_collat` empty (this flow does not set it), processbatch can
    // flip them ACTIVE with no collateral deposits.
    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      setup,
      "ProvisionDisputeOperators",
      `Provision the 3 SBP-less non-bootstrapped dispute batch operators, serving ${Constants.ContestedChain} only`,
      {},
      Constants.DisputeOperators.map(label => ({
        label,
        type: OperatorType.BATCH,
        isBootstrapped: false,
        servedChains: [Constants.ContestedChain]
      }))
    )

    // Nothing rebuilds a schedule mid-run. Every chain's window is two groups
    // (`batchOpGroups` 2), and each advance's `sysio.epoch::finishadv` draws the
    // new tail group from the chain's pool minus the group still seated: ACTIVE
    // batch operators SERVING the chain, non-bootstrapped first, then by
    // account. The dispute operators serve the contested chain from
    // provisioning, so once `processbatch` flips them ACTIVE
    // (`req_batchop_collat` is empty) its next natural advance, pushed by the
    // bootstrapped relays after their consensus on the epoch then live, seats
    // exactly the three of them as the tail, and the advance after the
    // bootstrapped group ahead of them relays its epoch brings them on duty.
    // Their epoch opens with an empty envelope bucket, and `deliver` accepts
    // only its active group, so only these 3 can deliver to it — being
    // SBP-less, only when the flow injects an envelope. The other chain's pool
    // never holds them.
    //
    // An advance between two flips would seat a mixed tail whose dispute
    // operators miss that epoch instead of owning it alone. An
    // advance never lands before the boundary, so the flips start only with
    // `activationHeadroomMs()` of chain time left before it.
    ClusterBuildPhase.create(
      setup,
      "ReshapeSchedule",
      `The ${Constants.ContestedChain} advances after the 3 dispute operators turn ACTIVE seat them as its active group`
    ).push(
      DisputeSteps.planAwaitActivationHeadroom(
        Actor.Sysio,
        "activation-headroom",
        `the ${Constants.ContestedChain} chain clock is far enough short of its next boundary for every ACTIVE flip to land before it`,
        headroomStepOptions
      ),
      ...Constants.DisputeOperators.map(operator =>
        DisputeSteps.planProcessbatch(
          Actor.Sysio,
          `force-eligible-${operator}`,
          `flip ${operator} eligible via opreg::processbatch`,
          {},
          operator,
          { was_eligible: false, is_eligible: true }
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
      DisputeSteps.planAwaitSoleActiveGroup(
        Actor.Sysio,
        "sole-active-group",
        `the next ${Constants.ContestedChain} advances seat the 3 dispute operators as exactly its active batch-operator group`,
        groupStepOptions
      )
    )

    // The advance that seated the dispute operators opened their epoch with an
    // empty envelope bucket, and with only them elected nothing delivers for
    // it, so no consensus forms and the contested chain freezes there. Wait for
    // the epoch index to hold while they own its group: the divergent split
    // staged on that epoch is its only delivery, so it opens a genuine dispute
    // instead of splitting an epoch whose consensus already formed.
    ClusterBuildPhase.create(
      setup,
      "SettleDisputeEpoch",
      `The ${Constants.ContestedChain} epoch settles (frozen) on the dispute-operators-owned epoch`
    ).push(
      verifyStep(
        Actor.Sysio,
        "settle-frozen-epoch",
        `the ${Constants.ContestedChain} epoch index freezes while the dispute operators own its active group`,
        verifySettledDisputeEpoch,
        settleStepOptions
      )
    )

    // ── 2. InjectDivergent — 3-way checksum split on the contested outpost ──
    const inject = ClusterBuildPhaseGroup.create(
      cluster,
      "InjectDivergent",
      `3 batch operators each deliver a distinct ${Constants.ContestedChain} envelope → 3-way checksum split`
    )

    // A dispute opens ONLY from deliver's inline evalcons, and only when that
    // deliver lands with now >= the chain's next_epoch_start (chkcons does NOT
    // open disputes) — so wait past the frozen epoch's boundary first, capturing
    // the contested epoch index, which the dispute operators must own, for every
    // subsequent deliver / dispute read. Its envelope bucket must still be
    // empty, so the three divergent deliveries are the only candidates.
    ClusterBuildPhase.create(
      inject,
      "StageContestedEpoch",
      `Chain clock passes the frozen ${Constants.ContestedChain} epoch's boundary; the contested epoch is captured with an empty envelope bucket`
    ).push(
      DisputeSteps.planStageContestedEpoch(
        Actor.Sysio,
        "stage-contested-epoch",
        `chain head-block time passes the ${Constants.ContestedChain} next_epoch_start; capture the contested epoch the dispute operators own`,
        stageStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "contested-bucket-empty",
        `no sysio.msgch::envelopes row exists for the contested ${Constants.ContestedChain} epoch before the divergent deliveries`,
        verifyContestedBucketEmpty
      )
    )

    // One phase per dispute operator (parallel), each delivering the operator's
    // DISTINCT divergent envelope for the contested outpost. The contested chain
    // runs its own consensus epoch, so no other outpost's consensus gates the
    // post-resolution advance where the slash runs.
    const deliveries = ClusterBuildPhaseGroup.create(
      inject,
      "DivergentDeliveries",
      `Each dispute operator delivers its divergent ${Constants.ContestedChain} envelope`,
      { parallel: true }
    )
    Constants.DisputeOperators.forEach((operator, index) => {
      ClusterBuildPhase.create(
        deliveries,
        `Deliver ${operator}`,
        `${operator} delivers its divergent ${Constants.ContestedChain} envelope`
      ).push(
        DisputeSteps.planDeliver(
          Actor.BatchOperator,
          `${operator}-deliver-${Constants.ContestedChain.toLowerCase()}`,
          `${operator} delivers its divergent ${Constants.ContestedChain} envelope (${Constants.EnvelopeTags[index]})`,
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
      `The 3-way split opens a dispute and pauses the ${Constants.ContestedChain} epoch only`
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
        `chalg::opendispute inline-paused the ${Constants.ContestedChain} epoch and not the ${Constants.RunningChain} epoch`,
        verifyEpochPaused
      )
    )

    // ── 2b. EconomicClockDuringDispute — the pause holds consensus only ──
    this.planEconomicClockDuringDispute(cluster)

    // ── 3. VoteAndResolve — Tier-1 vote → chkdispute resolves → unpause ──
    ClusterBuildPhase.create(
      cluster,
      "VoteAndResolve",
      `The 3 Tier-1 owners vote the canonical checksum; chkdispute resolves the dispute + unpauses the ${Constants.ContestedChain} epoch`
    ).push(
      // Every voter votes for the canonical checksum — 3 votes clears the live
      // quorum Q = floor(nodecount.t1_count/2)+1 (= 3 with the 3 voters + the
      // abstainer).
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
        `the ${Constants.ContestedChain} epoch unpauses after resolution`,
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

  /**
   * While the open dispute pauses the contested chain's consensus, the economic clock keeps
   * opening epochs: once with the batch-operator relays that crank `tickeconomy` running, and
   * again after every relay has been stopped and restarted against its retained data — the
   * contested chain's consensus stays paused at the contested epoch throughout. The relays
   * restart before the vote, so their `chkdispute` crank still resolves the dispute.
   *
   * @param cluster - The cluster build.
   */
  private planEconomicClockDuringDispute(cluster: ClusterBuild): void {
    const relays = NodeConfig.batchOperatorNodes(cluster.context.config),
      observationOptions = {
        timeoutMs: WireEconomicClockTool.awaitEconomicEpochsStepTimeoutMs(
          cluster.context.config.economicEpochDurationSec,
          Constants.EconomicEpochsPerObservation
        )
      },
      group = ClusterBuildPhaseGroup.create(
        cluster,
        "EconomicClockDuringDispute",
        `The dispute pause holds the ${Constants.ContestedChain} consensus only: the economic clock keeps opening epochs, across a restart of every batch-operator relay`
      )

    ClusterBuildPhase.create(
      group,
      "EconomicClockWhilePaused",
      `An economic epoch opens while the ${Constants.ContestedChain} consensus is paused`
    ).push(
      WireEconomicClockTool.planAwaitEconomicEpochsOpened(
        Actor.BatchOperator,
        "economic-epoch-while-paused",
        "the relays' tickeconomy crank opens an economic epoch during the dispute",
        observationOptions,
        Constants.EconomicEpochsPerObservation,
        Constants.DisputePauseObservation
      ),
      WireEconomicClockTool.planVerifyConsensusHeld(
        Actor.Sysio,
        "consensus-frozen-while-paused",
        `the ${Constants.ContestedChain} consensus stays paused at the contested epoch while the economic clock advances`,
        {},
        Constants.ContestedChain,
        [Constants.DisputePauseObservation]
      )
    )

    ClusterBuildPhase.create(
      group,
      "StopRelays",
      "Stop every batch-operator relay, retaining its data"
    ).push(
      ...relays.map(node =>
        Steps.processes.nodeop.planStop(
          Actor.BatchOperator,
          `stop-${node.name}`,
          `stop and reap ${node.name} (${node.batchOperatorLabel}), retaining its data`,
          { timeoutMs: Constants.RelayStopTimeoutMs },
          node.name
        )
      )
    )

    ClusterBuildPhase.create(
      group,
      "StartRelays",
      "Restart every batch-operator relay against its retained data"
    ).push(
      ...relays.map(node =>
        Steps.processes.nodeop.planStart(
          Actor.BatchOperator,
          `restart-${node.name}`,
          `relaunch ${node.name} (${node.batchOperatorLabel}) with its retained data and keys`,
          { timeoutMs: Constants.RelayStartTimeoutMs },
          node.name
        )
      )
    )

    ClusterBuildPhase.create(
      group,
      "EconomicClockAfterRelayRestart",
      `The restarted relays catch the economic clock up and keep it opening epochs while the ${Constants.ContestedChain} consensus stays paused`
    ).push(
      WireEconomicClockTool.planAwaitEconomicEpochsOpened(
        Actor.BatchOperator,
        "economic-epoch-after-relay-restart",
        "the restarted relays catch the economic clock up with its grid and open another epoch",
        observationOptions,
        Constants.EconomicEpochsPerObservation,
        Constants.RelayRestartObservation
      ),
      WireEconomicClockTool.planVerifyConsensusHeld(
        Actor.Sysio,
        "consensus-frozen-across-relay-restart",
        `the ${Constants.ContestedChain} consensus stayed paused at the same contested epoch across the restart while the economic index grew`,
        {},
        Constants.ContestedChain,
        [Constants.DisputePauseObservation, Constants.RelayRestartObservation]
      )
    )
  }
}
