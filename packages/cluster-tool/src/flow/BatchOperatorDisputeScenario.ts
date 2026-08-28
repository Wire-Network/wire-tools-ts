import Assert from "node:assert"
import { NodeOwnerTier, OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"
import type { ClusterBuildOptions } from "../config/ClusterBuildOptions.js"
import type { ClusterBuild } from "../orchestration/ClusterBuild.js"
import { ClusterBuildPhase } from "../orchestration/ClusterBuildPhase.js"
import { ClusterBuildPhaseGroup } from "../orchestration/ClusterBuildPhaseGroup.js"
import { ClusterBuildContext } from "../orchestration/ClusterBuildContext.js"
import { verifyStep, pollUntil } from "../orchestration/StepTools.js"
import { Steps } from "../orchestration/steps/index.js"
import { Report } from "../report/Report.js"
import { WireOperatorProvisioningTool } from "../tools/wire/WireOperatorProvisioningTool.js"
import { matchesProtoEnum } from "../utils/predicateUtils.js"
import { FlowScenario } from "./FlowScenario.js"
import { SlashingScenarioConstants as Constants } from "./SlashingScenarioConstants.js"
import { SlashingScenarioDisputeSteps as DisputeSteps } from "./steps/index.js"

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

/** A scheduled operator was administratively removed before contested delivery. */
async function verifyOperatorTerminated(
  ctx: ClusterBuildContext,
  operator: string
): Promise<void> {
  const row = await DisputeSteps.readOperator(ctx, operator)
  Assert.ok(row != null, `operator row missing for ${operator}`)
  Assert.ok(
    matchesProtoEnum(
      row.status,
      SysioOpregOperatorstatus,
      SysioOpregOperatorstatus.OPERATOR_STATUS_TERMINATED
    ),
    `${operator} must be OPERATOR_STATUS_TERMINATED before the contested deliveries`
  )
}

/** The configured group size remains three even when only two operators deliver. */
async function verifyConfiguredGroupSize(
  ctx: ClusterBuildContext
): Promise<void> {
  const { rows } = await ctx.wire.getEpochConfig()
  Assert.ok(rows.length === 1, "epochcfg singleton row missing")
  Assert.strictEqual(
    Number(rows[0].operators_per_epoch),
    Constants.DisputeOperatorCount,
    `epochcfg.operators_per_epoch must remain ${Constants.DisputeOperatorCount}`
  )
}

/** The topology-specific values layered over the common live dispute harness. */
export interface BatchOperatorDisputeScenarioOptions {
  /** Stable flow identifier used for reports and the flow runner. */
  readonly name: string
  /** One-line report description. */
  readonly description: string
  /** ACTIVE scheduled operators that inject the candidate envelopes. */
  readonly deliveryOperators: readonly string[]
  /** One distinct contested-envelope tag for every delivering operator. */
  readonly candidateTags: readonly string[]
  /** Non-canonical deliverers expected to be slashed after resolution. */
  readonly losingOperators: readonly string[]
  /** Scheduled operator to terminate after the three-member schedule is materialized. */
  readonly terminatedOperator?: string
}

/**
 * Reusable live OPP dispute harness. Concrete flows provide a zero-argument
 * constructor and select either the preserved three-way topology or the
 * production-shaped terminal two-way topology.
 */
export class BatchOperatorDisputeScenario extends FlowScenario {
  readonly name: string
  readonly description: string

  protected constructor(
    protected readonly options: BatchOperatorDisputeScenarioOptions
  ) {
    super()
    this.name = options.name
    this.description = options.description
  }

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    // Enough bootstrapped batch ops to keep the rest of the network healthy
    // while the dispute operators drive the contested outpost.
    batchOperatorCount: Constants.BootstrapBatchOperatorCount,
    // The dispute operators are the SOLE active group from the jump: bootstrap
    // materializes ONE group of exactly DisputeOperators.length. Setting the
    // group SIZE + COUNT here (never via a mid-run setconfig) is what makes the
    // batch-op group shape correct from bootstrap — no mid-run reconfig.
    operatorsPerEpoch: Constants.DisputeOperators.length,
    batchOpGroups: Constants.DisputeBatchOperatorGroupCount,
    // The dispute references the contested epoch's envelope log ~16 epochs later
    // (vote + tally + resolve + slash propagation), so retention must outlast it.
    epochRetentionEnvelopeLogCount: Constants.EpochRetentionEnvelopeLogCount,
    // Loosest VALID termination thresholds — see the constants' JSDoc.
    terminateMaxConsecutiveMisses: Constants.TerminateMaxConsecutiveMisses,
    terminateMaxPercentMisses24h: Constants.TerminateMaxPercentMisses24h
  }

  plan(cluster: ClusterBuild): void {
    const {
        candidateTags,
        deliveryOperators,
        losingOperators,
        terminatedOperator
      } = this.options,
      candidateCount = deliveryOperators.length,
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

    Assert.ok(
      candidateCount >= 2,
      "a dispute flow needs at least two deliveries"
    )
    Assert.strictEqual(
      candidateTags.length,
      candidateCount,
      "every delivering operator needs exactly one candidate tag"
    )
    Assert.strictEqual(
      new Set(candidateTags).size,
      candidateCount,
      "candidate tags must produce distinct checksums"
    )
    Assert.ok(
      deliveryOperators.includes(Constants.CanonicalOperator),
      `the canonical deliverer ${Constants.CanonicalOperator} must participate`
    )
    Assert.ok(
      losingOperators.every(operator => deliveryOperators.includes(operator)),
      "every expected slashing target must deliver a candidate"
    )
    Assert.ok(
      losingOperators.every(
        operator => operator !== Constants.CanonicalOperator
      ),
      "the canonical deliverer cannot be a slashing target"
    )
    Assert.ok(
      terminatedOperator == null ||
        (Constants.DisputeOperators.some(
          operator => operator === terminatedOperator
        ) &&
          !deliveryOperators.includes(terminatedOperator)),
      "a terminated operator must be scheduled but absent from contested delivery"
    )

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

    // The 3 scheduled operators, provisioned SBP-less (no daemon) and
    // non-bootstrapped via the ONE provisioning mechanism, so they never
    // auto-deliver — the flow pushes their deliveries by hand. With
    // `req_batchop_collat` empty (this flow does not set it), processbatch can
    // flip them ACTIVE with no collateral deposits.
    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      setup,
      "ProvisionDisputeOperators",
      "Provision the 3 SBP-less non-bootstrapped dispute batch operators",
      {},
      Constants.DisputeOperators.map((label, index) => ({
        label,
        type: OperatorType.BATCH,
        ethereumHdIndex: Constants.DisputeOperatorEthereumHdBase + index,
        isBootstrapped: false
      }))
    )

    // The epoch config ALREADY materialized ONE group of exactly
    // DisputeOperators.length at BOOTSTRAP (via the scenario defaults —
    // `operatorsPerEpoch` / `batchOpGroups`), so there is NO mid-run
    // `setconfig`: the batch-op group SIZE + COUNT never change after bootstrap
    // (the depot's #529 invariant forbids resizing a materialized rotation
    // anyway). Here we only flip the 3 SBP-less dispute ops ACTIVE
    // (`processbatch`, since `req_batchop_collat` is empty), then re-materialize
    // the rotation with a fresh `schbatchgps` — the ONLY way to fold the
    // now-active, non-bootstrapped dispute ops into the schedule (`advance()`
    // rotates the already-materialized schedule; it does NOT re-select members).
    // `schbatchgps` sorts non-bootstrapped ops first, then by name, so the three
    // `dispop.*` fill the single group and the bootstrapped harness ops fall
    // outside it. `deliver` is gated to the active group, so only these 3 can
    // deliver — and being SBP-less, only when the flow injects an envelope.
    // `sysio.epoch@active` resolves to `sysio@active` (the governance key in
    // kiod), so the flow can sign `schbatchgps`.
    ClusterBuildPhase.create(
      setup,
      "ReshapeSchedule",
      "One group of exactly the 3 dispute operators"
    ).push(
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

    if (terminatedOperator != null) {
      ClusterBuildPhase.create(
        setup,
        "DegradeLiveGroup",
        "Administratively terminate one scheduled operator, leaving two live delivery candidates"
      ).push(
        Steps.contracts.sysio.opreg.planTerminate(
          Actor.Sysio,
          `terminate-${terminatedOperator}`,
          `administratively terminate ${terminatedOperator} before contested delivery`,
          {},
          terminatedOperator,
          "WIRE-362 terminal two-way dispute coverage"
        ),
        verifyStep(
          Actor.Sysio,
          `${terminatedOperator}-terminated`,
          `${terminatedOperator} is OPERATOR_STATUS_TERMINATED`,
          ctx => verifyOperatorTerminated(ctx, terminatedOperator)
        ),
        verifyStep(
          Actor.Sysio,
          "configured-group-size",
          `epochcfg retains operators_per_epoch=${Constants.DisputeOperatorCount} while ${candidateCount} live operators contest the dispute`,
          verifyConfiguredGroupSize
        )
      )
    }

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

    // ── 2. InjectDivergent — contested checksum split on the contested outpost ──
    const inject = ClusterBuildPhaseGroup.create(
      cluster,
      "InjectDivergent",
      `${candidateCount} live batch operators each deliver the consensus SOLANA envelope + a distinct ETHEREUM envelope`
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

    // The phases remain distinct: all live operators first publish the same
    // SOLANA envelope, then publish their conflicting ETHEREUM envelopes. Both
    // phases are deliberately parallel so each operator reads one shared
    // pre-delivery tip through InboundTipReader's single-flight cache.
    ClusterBuildPhase.create(
      inject,
      "ConsensusSolanaDeliveries",
      "All live operators deliver the consensus SOLANA envelope",
      [],
      { parallelize: true }
    ).push(
      ...deliveryOperators.map(operator =>
        DisputeSteps.planDeliver(
          Actor.BatchOperator,
          `${operator}-deliver-solana`,
          `${operator} delivers the consensus SOLANA envelope`,
          {},
          operator,
          Constants.NonContestedChainCode,
          Constants.ConsensusEnvelopeTag
        )
      )
    )

    ClusterBuildPhase.create(
      inject,
      "CandidateEthereumDeliveries",
      "All live operators deliver distinct ETHEREUM candidate envelopes",
      [],
      { parallelize: true }
    ).push(
      ...deliveryOperators.map((operator, index) =>
        DisputeSteps.planDeliver(
          Actor.BatchOperator,
          `${operator}-deliver-ethereum`,
          `${operator} delivers its divergent ETHEREUM envelope (${candidateTags[index]})`,
          {},
          operator,
          Constants.ContestedChainCode,
          candidateTags[index]
        )
      )
    )

    ClusterBuildPhase.create(
      inject,
      "DisputeOpens",
      "The exhausted candidate set opens a dispute and pauses the epoch"
    ).push(
      DisputeSteps.planAwaitDisputeOpened(
        Actor.Sysio,
        "dispute-opens",
        "an OPEN dispute row appears for the contested (outpost, epoch) with a candidate per operator",
        disputeOpenStepOptions,
        candidateCount
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

    // ── 4. SlashNonCanonical — configured losers SLASHED, winner untouched ──
    ClusterBuildPhase.create(
      cluster,
      "SlashNonCanonical",
      "Non-canonical deliverers flip SLASHED; the canonical deliverer does not"
    ).push(
      ...losingOperators.map(operator =>
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
