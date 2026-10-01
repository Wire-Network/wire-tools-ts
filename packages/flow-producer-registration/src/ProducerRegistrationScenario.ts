import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterBuildPhase,
  Constants as ClusterToolConstants,
  FlowScenario,
  ProducerNodeTool,
  ProducerTier,
  ProtocolTiming,
  Report,
  Steps,
  WireCollateralTool,
  WireOperatorProvisioningTool,
  matchesProtoEnum,
  pollUntil,
  producerName,
  producerTier,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { ProducerRegistrationScenarioConstants as Constants } from "./ProducerRegistrationScenarioConstants.js"

const { SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report


/** The flow producer's on-chain WIRE account, resolved from the key store by its label. */
function producerAccount(ctx: ClusterBuildContext): string {
  return ctx.keyStore.assertOperator(Constants.ProducerLabel).account
}

/** True while the flow producer's operator row is `OPERATOR_STATUS_ACTIVE`. */
async function isOperatorActive(ctx: ClusterBuildContext): Promise<boolean> {
  const operator = await WireCollateralTool.readOperatorRow(ctx, Constants.ProducerLabel)
  return (
    operator != null &&
    matchesProtoEnum(
      operator.status,
      SysioOpregOperatorstatus,
      SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
    )
  )
}

/** The flow producer's row on `sysio::producers` (a read). */
async function readProducerRow(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioSystemProducerInfoType> {
  const account = producerAccount(ctx),
    { rows } = await ctx.wire.getProducers()
  return rows.find(row => row.owner === account)
}

/**
 * The producers the ACTIVE schedule names — the set actually taking turns. A pending or proposed
 * schedule becomes it only once its proposing block is FINAL.
 */
async function activeScheduleProducers(ctx: ClusterBuildContext): Promise<string[]> {
  return (await ctx.wire.getProducerSchedule()).active.producers
}

/** True once the flow producer has actually produced a block. */
async function hasProducedBlock(ctx: ClusterBuildContext): Promise<boolean> {
  return (await ctx.wire.getInfo()).head_block_producer === producerAccount(ctx)
}

/**
 * The schedule size the round budgets derive from: the genesis producers plus the flow's own.
 *
 * Derived rather than pinned so the budgets track `producerCount` if the defaults move.
 */
const ScheduleSize = Constants.ProducerCount + 1

/** The genesis producers' on-chain names — the only names the schedule may hold after an exit. */
const GenesisProducers = Array.from({ length: Constants.ProducerCount }, (_, index) =>
  producerName(index)
)

/**
 * The body of both schedule-exit verifies: the ACTIVE schedule drops the flow producer, keeps
 * only genesis producers, and stays above the floor.
 *
 * Asserted on the active schedule, never on who holds the head block — any other producer holds
 * it 11 slots in 12, so a head-block check passes while the producer is still scheduled. The
 * floor is the proof that the exit was published rather than retained: below `min_schedule_size`
 * the rebuild keeps the last good schedule and the exiting producer would keep producing. It is
 * NOT asserted that every genesis producer kept its slot: the flow's own demotion threshold
 * applies to them too, and a genesis node that misses three rounds on a loaded host is dropped
 * exactly as the flow producer was.
 */
async function verifyProducerLeavesSchedule(ctx: ClusterBuildContext): Promise<void> {
  const account = producerAccount(ctx)
  await pollUntil(
    "the active schedule no longer names the flow producer",
    async () => !(await activeScheduleProducers(ctx)).includes(account),
    Constants.scheduleDeadlineMs(ScheduleSize),
    Constants.PollIntervalMs
  )
  const schedule = await activeScheduleProducers(ctx),
    strangers = schedule.filter(name => !GenesisProducers.includes(name))
  if (strangers.length > 0) {
    throw new Error(
      `the active schedule names ${strangers.join(", ")} after the exit; only genesis producers should remain`
    )
  }
  if (schedule.length < ClusterToolConstants.MIN_SCHEDULE_SIZE) {
    throw new Error(
      `the active schedule holds ${schedule.length} producers after the exit, below the ${ClusterToolConstants.MIN_SCHEDULE_SIZE} floor — the rebuild would have been retained, not published`
    )
  }
}

/**
 * Block Producer Registration — a fresh account driven from provisioning all the way to
 * producing blocks, then out of the schedule and back:
 *
 * 0. **ScoreConfig** — the flow INSTALLS the score weights and the demotion threshold it later
 *    asserts against (`setscorecfg`), rather than assuming the contract's defaults.
 * 1. **ProvisionProducer** — the ONE provisioning mechanism creates the account (unique WIRE
 *    key + its own finalizer key, ETH + SOL identities, authex links, `regoperator`). No
 *    `producerNodeIndex`, so it takes the collateral-backed route, not the genesis one.
 * 2. **NegativeCase** — `regproducer` BEFORE collateral must be rejected; no producer row is
 *    created while the operator is UNKNOWN.
 * 3. **Deposit** — `sysio` funds the account with WIRE and it bonds the WIRE on the depot
 *    through `opreg::deposit`; the `(WIRE, WIRE)` minimum is met and the operator flips ACTIVE
 *    in the same transaction.
 * 4. **RegisterProducer** — only now create the producer row and finalizer key; its first score
 *    lands in the healthy tier.
 * 5. **StartProducerNode** — its own nodeop, peered into the mesh.
 * 6. **EntersSchedule** — it enters the ranked schedule and PRODUCES A BLOCK. This is also the
 *    first end-to-end coverage anywhere of the `regfinkey` → `set_proposed_finalizers` path; a
 *    cluster otherwise installs finality directly at genesis.
 * 7. **MissedRounds** — its node is stopped (a controlled stop; the flow owns the process). The
 *    miss counter climbs, demotion fires at exactly the installed threshold, and the ACTIVE
 *    schedule drops it while every genesis producer keeps its slot.
 * 8. **Recover** — the node restarts and `regproducer` clears the DEMOTION, returning eligibility
 *    without wiping the record: the miss streak survives, because re-registering costs only a
 *    signature and could otherwise be called on a timer by an operator that never produces. The
 *    producer re-enters the schedule, produces, and THAT is what clears the streak.
 * 9. **Removal** — the whole bond is withdrawn. `opreg::withdraw` re-evaluates eligibility
 *    inline, so the operator leaves ACTIVE in the same transaction, and the active schedule
 *    drops it — the collateral-driven exit that mirrors the collateral-driven entry in phase 3.
 * 10. **ReturnBond** — after the withdraw wait, `flushwtdw` debits the balance row and credits
 *    `remitclaims{account, WIRE}`; `opreg::claimremit` pays the bond back to the account's
 *    liquid WIRE.
 */
export class ProducerRegistrationScenario extends FlowScenario {
  readonly name = "flow-producer-registration"
  readonly description =
    "A fresh account bonds WIRE on the depot, registers as a producer, enters the ranked schedule, is demoted for missed rounds, recovers, and withdraws its bond"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    // One producer ACCOUNT per producer NODE — see the constants' note on why the two counts
    // are set equal, and why one above the `min_schedule_size` floor.
    nodeCount: Constants.NodeCount,
    producerCount: Constants.ProducerCount,
    // The flow starts one node of its own, outside `NodeConfig.plan`.
    adHocCount: Constants.AdHocNodeCount,
    // Without this the requirement vector is empty, `meets_role_min` refuses every
    // non-bootstrapped producer by design, and the flow's account could never leave UNKNOWN.
    requiredProducerCollateral: [WireCollateralTool.createWireRequirement(Constants.MinimumBond)]
  }

  plan(cluster: ClusterBuild): void {
    const scoreStepOptions = {
        timeoutMs: Constants.scoreDeadlineMs() + ProtocolTiming.PollDeadlineBufferMs
      },
      scheduleStepOptions = {
        timeoutMs:
          Constants.scheduleDeadlineMs(ScheduleSize) + ProtocolTiming.PollDeadlineBufferMs
      },
      demotionStepOptions = {
        timeoutMs:
          Constants.demotionDeadlineMs(ScheduleSize) + ProtocolTiming.PollDeadlineBufferMs
      },
      // The same epoch duration the claim verify's runner reads (`ctx.config.epochDurationSec`).
      remitClaimStepOptions = {
        timeoutMs: WireCollateralTool.remitClaimStepTimeoutMs(cluster.context.config.epochDurationSec)
      }

    // ── 0. Install the weights + the demotion threshold the flow asserts against ──
    ClusterBuildPhase.create(
      cluster,
      "ScoreConfig",
      "Install the producer score weights and the missed-round demotion threshold"
    ).push(
      Steps.contracts.sysio.system.planSetscorecfg(
        Actor.Sysio,
        "setscorecfg",
        `install prodscorecfg with max_consecutive_missed_rounds = ${Constants.MaxConsecutiveMissedRounds}`,
        {},
        { weights: Constants.ScoreConfig }
      )
    )

    // ── 1. Provision the collateral-backed producer (the ONE mechanism) ──
    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      cluster,
      "ProvisionProducer",
      "Provision the collateral-backed producer operator",
      {},
      [
        {
          label: Constants.ProducerLabel,
          type: OperatorType.PRODUCER,
          // No `producerNodeIndex` — that is what routes this through the collateral-backed
          // path (sponsored account, authex links, regoperator) instead of the genesis one.
          ethereumHdIndex: Constants.ProducerEthereumHdIndex,
          isBootstrapped: false
        }
      ]
    )

    // ── 2. Prove registration is refused with NO collateral behind it ──
    ClusterBuildPhase.create(
      cluster,
      "NegativeCase",
      "Reject producer registration before collateral admission"
    ).push(
      verifyStep(
        Actor.Producer,
        "reject-unbonded-regproducer",
        "registration is rejected, the operator stays UNKNOWN, and no producer row is created",
        async (ctx, signal) => {
          await Assert.rejects(
            () =>
              Steps.consensus.runRegisterProducer(
                ctx,
                {
                  kind: "ConsensusSteps.ProducerRegistrationInput",
                  label: Constants.ProducerLabel
                },
                signal
              ),
            error => {
              const message = error instanceof Error ? error.message : String(error)
              ctx.log.debug(`unbonded producer registration rejected: ${message}`)
              return Constants.ProducerAdmissionErrorPattern.test(message)
            },
            "expected producer registration to fail before collateral admission"
          )

          const operator = await WireCollateralTool.readOperatorRow(ctx, Constants.ProducerLabel)
          Assert.ok(
            operator != null,
            "the provisioned producer operator row is missing"
          )
          Assert.ok(
            matchesProtoEnum(
              operator.status,
              SysioOpregOperatorstatus,
              SysioOpregOperatorstatus.OPERATOR_STATUS_UNKNOWN
            ),
            "the unbonded producer operator must remain UNKNOWN after rejected registration"
          )
          Assert.ok(
            (await readProducerRow(ctx)) == null,
            "rejected registration must not create a producer row"
          )
        },
        {}
      )
    )

    // ── 3. Fund + bond WIRE on the depot → balance row, ACTIVE ──
    ClusterBuildPhase.create(
      cluster,
      "Deposit",
      "Bond WIRE on the depot; the producer operator flips ACTIVE"
    ).push(
      ...WireCollateralTool.planDeposit(
        Actor.Producer,
        "deposit-wire",
        `bond ${Constants.BondAmount} WIRE units of producer collateral through sysio.opreg::deposit`,
        {},
        Constants.ProducerLabel,
        WireCollateralTool.createWireCollateral(Constants.BondAmount)
      ),
      WireCollateralTool.planVerifyBalanceRow(
        Actor.Sysio,
        "depot-balance-holds-bond",
        `the (WIRE, WIRE) balance row holds exactly ${Constants.BondAmount}`,
        {},
        Constants.ProducerLabel,
        WireCollateralTool.createWireCollateral(Constants.BondAmount)
      ),
      verifyStep(
        Actor.Sysio,
        "depot-status-active",
        "the bond meets the producer minimum; the operator is OPERATOR_STATUS_ACTIVE",
        async ctx => {
          // `deposit` re-evaluates eligibility inline, so one read after its Step is final.
          Assert.ok(
            await isOperatorActive(ctx),
            `${Constants.ProducerLabel} is not OPERATOR_STATUS_ACTIVE after bonding the minimum`
          )
        }
      )
    )

    // ── 4. ACTIVE operator → producer row + finalizer key → initial score ──
    ClusterBuildPhase.create(
      cluster,
      "RegisterProducer",
      "Register the admitted producer and its finalizer key"
    ).push(
      Steps.consensus.planRegisterProducer(
        Actor.Producer,
        "regproducer-flowprod",
        "register the admitted flow producer",
        {},
        Constants.ProducerLabel
      ),
      Steps.consensus.planRegisterFinalizerKey(
        Actor.Producer,
        "regfinkey-flowprod",
        "register the flow producer's finalizer key",
        {},
        Constants.ProducerLabel
      ),
      verifyStep(
        Actor.Sysio,
        "registration-scores-the-producer",
        "registration scores the admitted producer in the healthy tier",
        async ctx => {
          // The score is what ranking ORDERS on, and an unscored row sits in the demoted tier
          // where no consumer's walk ever reaches it. Registration reads the already-posted
          // collateral for the initial score; regfinkey then rescores the row into schedulable
          // standing. The tier is read from the key itself.
          await pollUntil(
            "producer rank_score in the healthy tier",
            async () => {
              const producer = await readProducerRow(ctx)
              return (
                producer != null &&
                producerTier(producer.rank_score) === ProducerTier.healthy
              )
            },
            Constants.scoreDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        scoreStepOptions
      )
    )

    // ── 5. Its own producing node ──
    ClusterBuildPhase.create(
      cluster,
      "StartProducerNode",
      "Start the flow producer's own nodeop"
    ).push(
      ProducerNodeTool.planProducerNodeStart(
        Actor.Producer,
        "start-producer-node",
        `start ${Constants.ProducerLabel}'s producing node`,
        {},
        Constants.ProducerLabel
      )
    )

    // ── 6. It enters the ranked schedule and produces ──
    ClusterBuildPhase.create(
      cluster,
      "EntersSchedule",
      "The producer enters the ranked schedule and produces a block"
    ).push(
      verifyStep(
        Actor.Producer,
        "producer-produces-a-block",
        "the flow producer becomes head_block_producer",
        async ctx => {
          // Producing a block is the assertion, not merely appearing in a proposed schedule: a
          // pending schedule only activates once its proposing block is FINAL, so this also
          // proves the finalizer policy update_ranked_producers published is one the cluster
          // can actually vote for.
          await pollUntil(
            "flow producer produced a block",
            () => hasProducedBlock(ctx),
            Constants.scheduleDeadlineMs(ScheduleSize),
            Constants.PollIntervalMs
          )
        },
        scheduleStepOptions
      )
    )

    // ── 7. Stop its node; misses accrue; demotion fires; the schedule drops it ──
    ClusterBuildPhase.create(
      cluster,
      "MissedRounds",
      "Stop the producer's node; misses accrue, demotion fires, the schedule drops it"
    ).push(
      ProducerNodeTool.planProducerNodeStop(
        Actor.Producer,
        "stop-producer-node",
        `stop ${Constants.ProducerLabel}'s node so it misses its rounds`,
        {},
        Constants.ProducerLabel
      ),
      verifyStep(
        Actor.Sysio,
        "misses-accrue-then-demote",
        `consecutive_missed_rounds reaches ${Constants.MaxConsecutiveMissedRounds} and demotion fires`,
        async ctx => {
          await pollUntil(
            "producer demoted for consecutive missed rounds",
            async () => {
              const producer = await readProducerRow(ctx)
              return producer != null && producer.is_demoted
            },
            Constants.demotionDeadlineMs(ScheduleSize),
            Constants.PollIntervalMs
          )
          const demoted = await readProducerRow(ctx)
          if (demoted == null) {
            throw new Error("the producer's row disappeared after its demotion")
          }
          // Exactly the threshold the flow installed, not merely "at least": demoting early
          // would evict a producer that had not yet earned it.
          if (demoted.consecutive_missed_rounds < Constants.MaxConsecutiveMissedRounds) {
            throw new Error(
              `demoted at ${demoted.consecutive_missed_rounds} misses, below the installed ${Constants.MaxConsecutiveMissedRounds}`
            )
          }
          if (producerTier(demoted.rank_score) !== ProducerTier.demoted) {
            throw new Error(
              `is_demoted is set but rank_score ${demoted.rank_score} is not in the demoted tier`
            )
          }
        },
        demotionStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "demoted-producer-leaves-the-schedule",
        "the active schedule drops the demoted producer and every genesis producer keeps its slot",
        verifyProducerLeavesSchedule,
        scheduleStepOptions
      )
    )

    // ── 8. Restart + regproducer → back in the schedule ──
    ClusterBuildPhase.create(
      cluster,
      "Recover",
      "Restart the node and re-register; the producer returns to the schedule"
    ).push(
      ProducerNodeTool.planProducerNodeStart(
        Actor.Producer,
        "restart-producer-node",
        `restart ${Constants.ProducerLabel}'s node`,
        {},
        Constants.ProducerLabel
      ),
      Steps.consensus.planRegisterProducer(
        Actor.Producer,
        "rereg-producer",
        "re-register the producer — the single door back from demotion",
        {},
        Constants.ProducerLabel
      ),
      verifyStep(
        Actor.Sysio,
        "demotion-cleared",
        "regproducer pardons a producer the schedule dropped, clearing the demotion and the streak",
        async ctx => {
          const producer = await readProducerRow(ctx)
          if (producer == null) {
            throw new Error("the producer's row disappeared after re-registration")
          }
          if (producer.is_demoted) {
            throw new Error("regproducer left the producer demoted")
          }
          // The pardon is gated on the producer having actually LEFT the schedule, which the
          // previous step asserted. That gate is what makes clearing the streak safe: a producer
          // still holding a slot is refused the pardon outright and recovers by serving a round,
          // so the repeatable-regproducer loop has nothing to clear. Off the schedule there are no
          // rounds left to serve, so the streak clears with the flag or it would be permanent.
          if (producer.consecutive_missed_rounds !== 0) {
            throw new Error(
              `regproducer left a miss streak of ${producer.consecutive_missed_rounds}; ` +
                "a pardon for an unscheduled producer must clear it, since it has no round to serve"
            )
          }
        },
        {}
      ),
      verifyStep(
        Actor.Producer,
        "producer-produces-again",
        "the recovered producer produces a block again",
        async ctx => {
          await pollUntil(
            "recovered producer produced a block",
            () => hasProducedBlock(ctx),
            Constants.scheduleDeadlineMs(ScheduleSize),
            Constants.PollIntervalMs
          )
        },
        scheduleStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "served-rounds-keep-the-record-clean",
        "the recovered producer stays healthy while it serves its rounds",
        async ctx => {
          // The pardon already zeroed the streak, so this is not re-asserting the clear — it is
          // asserting the producer does not fall straight back. A round is scored once, at the
          // transition where it ENDS, so waiting for the head to move OFF this producer is what
          // makes the verdict readable: only then has its round been judged, and a SERVED verdict
          // is the one that leaves the streak at zero and the demotion off.
          await pollUntil(
            "the recovered producer's round ended and was scored",
            async () => !(await hasProducedBlock(ctx)),
            Constants.scheduleDeadlineMs(ScheduleSize),
            Constants.PollIntervalMs
          )
          const producer = await readProducerRow(ctx)
          if (producer == null) {
            throw new Error("the producer's row disappeared after it produced again")
          }
          if (producer.is_demoted) {
            throw new Error("the recovered producer was demoted again while serving its rounds")
          }
          if (producer.consecutive_missed_rounds !== 0) {
            throw new Error(
              `the recovered producer accrued a miss streak of ${producer.consecutive_missed_rounds} ` +
                "while serving its rounds"
            )
          }
        },
        {}
      )
    )

    // ── 9. Withdraw the bond → below the minimum → out of the schedule ──
    ClusterBuildPhase.create(
      cluster,
      "Removal",
      "Withdraw the whole bond; the producer drops below the minimum and leaves the schedule"
    ).push(
      // The runner fails the Step unless a new wtdwqueue row for exactly this amount appears.
      WireCollateralTool.planWithdrawal(
        Actor.Producer,
        "withdraw-wire",
        `withdraw the whole ${Constants.WithdrawAmount} WIRE-unit bond`,
        {},
        Constants.ProducerLabel,
        WireCollateralTool.createWireCollateral(Constants.WithdrawAmount)
      ),
      verifyStep(
        Actor.Sysio,
        "depot-status-leaves-active",
        "the producer leaves OPERATOR_STATUS_ACTIVE once it is under the minimum",
        async ctx => {
          // The queued amount no longer counts as available, and `withdraw` re-evaluates
          // eligibility inline, so the status is final once the withdraw Step returns.
          Assert.ok(
            !(await isOperatorActive(ctx)),
            `${Constants.ProducerLabel} is still OPERATOR_STATUS_ACTIVE with its whole bond queued for withdrawal`
          )
        }
      ),
      verifyStep(
        Actor.Sysio,
        "unbonded-producer-leaves-the-schedule",
        "the active schedule drops the unbonded producer and every genesis producer keeps its slot",
        // No ACTIVE opreg row means no rank position, so the next rebuild drops it — absorbed
        // rather than retained, because the genesis producers alone still exceed the floor.
        verifyProducerLeavesSchedule,
        scheduleStepOptions
      )
    )

    // ── 10. The withdrawal matures into a claim; claimremit pays the bond back ──
    ClusterBuildPhase.create(
      cluster,
      "ReturnBond",
      "flushwtdw credits the withdrawn bond to remitclaims; claimremit pays it back"
    ).push(
      WireCollateralTool.planVerifyRemitClaim(
        Actor.Sysio,
        "flush-credits-remit-claim",
        `remitclaims{producer, WIRE} holds exactly ${Constants.WithdrawAmount}`,
        remitClaimStepOptions,
        Constants.ProducerLabel,
        WireCollateralTool.createWireClaim(Constants.WithdrawAmount)
      ),
      WireCollateralTool.planVerifyBalanceRow(
        Actor.Sysio,
        "depot-balance-emptied",
        "the (WIRE, WIRE) balance row is empty after the flush",
        {},
        Constants.ProducerLabel,
        WireCollateralTool.createWireCollateral(0n)
      ),
      WireCollateralTool.planRecordWireBalance(
        Actor.Producer,
        "record-wire-before-claim",
        "record the producer's liquid WIRE before the claim",
        {},
        Constants.ProducerLabel
      ),
      WireCollateralTool.planClaimremit(
        Actor.Producer,
        "claimremit-wire",
        "claim the returned bond through sysio.opreg::claimremit",
        {},
        Constants.ProducerLabel,
        WireCollateralTool.WireTokenCode
      ),
      WireCollateralTool.planVerifyWireBalanceIncrease(
        Actor.Producer,
        "claim-pays-bond",
        `the producer's liquid WIRE rises by exactly ${Constants.WithdrawAmount}`,
        {},
        Constants.ProducerLabel,
        Constants.WithdrawAmount
      ),
      WireCollateralTool.planVerifyRemitClaim(
        Actor.Sysio,
        "claim-row-cleared",
        "remitclaims{producer, WIRE} is gone after the payout",
        remitClaimStepOptions,
        Constants.ProducerLabel,
        WireCollateralTool.createWireClaim(0n)
      )
    )
  }
}
