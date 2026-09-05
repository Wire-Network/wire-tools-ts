import { SysioContracts } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterBuildPhase,
  Constants as ClusterToolConstants,
  EthereumCollateralTool,
  FlowScenario,
  ProducerNodeTool,
  ProducerTier,
  ProtocolTiming,
  Report,
  SolanaCollateralTool,
  Steps,
  WireOperatorProvisioningTool,
  matchesProtoEnum,
  pollUntil,
  producerName,
  producerTier,
  sleep,
  slugValue,
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

/** The flow producer's operator row on `sysio.opreg::operators` (a read). */
async function readOperatorRow(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioOpregOperatorEntryType> {
  const account = producerAccount(ctx),
    { rows } = await ctx.wire.getOperators()
  return rows.find(row => row.account === account)
}

/** True while the flow producer's operator row is `OPERATOR_STATUS_ACTIVE`. */
async function isOperatorActive(ctx: ClusterBuildContext): Promise<boolean> {
  const operator = await readOperatorRow(ctx)
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

/**
 * Every producer ANY schedule names — active, pending, or proposed — so a "never scheduled"
 * assertion also covers a change still in flight.
 */
async function scheduledProducers(ctx: ClusterBuildContext): Promise<string[]> {
  const { active, pending, proposed } = await ctx.wire.getProducerSchedule()
  return [active, pending, proposed]
    .filter(schedule => schedule != null)
    .flatMap(schedule => schedule.producers)
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
 * 2. **NegativeCase** — `regproducer` + `regfinkey` BEFORE any collateral. Asserted here rather
 *    than after the deposits so the ordering is unambiguous: registration alone must NOT make a
 *    producer schedulable, so no schedule (active, pending, or proposed) ever names it.
 * 3. **DepositEthereum** / 4. **DepositSolana** — bond on both outposts; the all-chain rule is
 *    met, the operator flips ACTIVE, and its `rank_score` moves into the healthy tier.
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
 * 9. **Removal** — the whole ETH bond is withdrawn. The operator drops below the per-chain
 *    minimum, leaves ACTIVE, and the active schedule drops it — the collateral-driven exit that
 *    mirrors the collateral-driven entry in phases 3-4. This depends on `opreg::withdraw`
 *    re-evaluating eligibility (WIRE-351, wire-sysio PR #589).
 */
export class ProducerRegistrationScenario extends FlowScenario {
  readonly name = "flow-producer-registration"
  readonly description =
    "A fresh account registers as a producer, bonds collateral, enters the ranked schedule, is demoted for missed rounds, and recovers"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    // One producer ACCOUNT per producer NODE — see the constants' note on why the two counts
    // are set equal, and why one above the `min_schedule_size` floor.
    nodeCount: Constants.NodeCount,
    producerCount: Constants.ProducerCount,
    // Without this the requirement vector is empty, `meets_role_min` refuses every
    // non-bootstrapped producer by design, and the flow's account could never leave UNKNOWN.
    requiredProducerCollateral: [
      {
        chainCode: Constants.EthereumChainCode,
        tokenCode: Constants.EthereumTokenCode,
        minimumBond: Number(Constants.MinimumBond)
      },
      {
        chainCode: Constants.SolanaChainCode,
        tokenCode: Constants.SolanaTokenCode,
        minimumBond: Number(Constants.MinimumBond)
      }
    ]
  }

  plan(cluster: ClusterBuild): void {
    const relayStepOptions = {
        timeoutMs: Constants.relayDeadlineMs() + ProtocolTiming.PollDeadlineBufferMs
      },
      scheduleStepOptions = {
        timeoutMs:
          Constants.scheduleDeadlineMs(ScheduleSize) + ProtocolTiming.PollDeadlineBufferMs
      },
      demotionStepOptions = {
        timeoutMs:
          Constants.demotionDeadlineMs(ScheduleSize) + ProtocolTiming.PollDeadlineBufferMs
      },
      outpostWriteStepOptions = { timeoutMs: ProtocolTiming.OutpostWriteBudgetMs }

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
          isBootstrapped: false,
          airdropSolanaLamports: Constants.ProducerAirdropLamports
        }
      ]
    )

    // ── 2. Register + key it, with NO collateral behind it yet ──
    ClusterBuildPhase.create(
      cluster,
      "NegativeCase",
      "Register the producer and its finalizer key BEFORE any collateral"
    ).push(
      Steps.consensus.planGrantProducerRam(
        Actor.Sysio,
        "setacctram-flowprod",
        "grant the flow producer RAM for its producer + finalizer-key rows",
        {},
        Constants.ProducerLabel,
        Steps.consensus.ProducerRamBytes
      ),
      Steps.consensus.planRegisterProducer(
        Actor.Producer,
        "regproducer-flowprod",
        "register the flow producer",
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
        "unbonded-producer-is-never-scheduled",
        "a registered but unbonded producer stays UNKNOWN and no schedule ever names it",
        async ctx => {
          // Held across a full schedule-rebuild window: `update_ranked_producers` fires roughly
          // once a minute, so a shorter check would pass merely because no rebuild had run.
          const account = producerAccount(ctx),
            deadline = Date.now() + Constants.scheduleDeadlineMs(ScheduleSize)
          while (Date.now() < deadline) {
            if (await isOperatorActive(ctx)) {
              throw new Error(
                "an unbonded producer reached OPERATOR_STATUS_ACTIVE — meets_role_min let an empty bond through"
              )
            }
            if ((await scheduledProducers(ctx)).includes(account)) {
              throw new Error(
                "an unbonded producer was scheduled — it holds a rank position without collateral"
              )
            }
            await sleep(Constants.PollIntervalMs)
          }
        },
        scheduleStepOptions
      )
    )

    // ── 3. ETH bond → depot balance row ──
    ClusterBuildPhase.create(
      cluster,
      "DepositEthereum",
      "Bond ETH collateral; depot credits the balance row"
    ).push(
      EthereumCollateralTool.planDeposit(
        Actor.User,
        "deposit-ethereum",
        `deposit ${Constants.BondAmount} wei ETH producer collateral`,
        outpostWriteStepOptions,
        Constants.ProducerLabel,
        OperatorType.PRODUCER,
        BigInt(Constants.EthereumTokenCode),
        Constants.BondAmount
      ),
      verifyStep(
        Actor.Sysio,
        "depot-credits-ethereum",
        "the producer's ETH balance row appears on sysio.opreg",
        async ctx => {
          await pollUntil(
            "producer's ETH balance row on sysio.opreg",
            async () => {
              const operator = await readOperatorRow(ctx)
              return (operator?.balances ?? []).some(
                balance =>
                  slugValue(balance.chain_code) === Constants.EthereumChainCode &&
                  Number(balance.balance) >= Number(Constants.MinimumBond)
              )
            },
            Constants.relayDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        relayStepOptions
      )
    )

    // ── 4. SOL bond → all-chain rule met → ACTIVE → scored ──
    ClusterBuildPhase.create(
      cluster,
      "DepositSolana",
      "Bond SOL collateral; the producer operator flips ACTIVE and is scored"
    ).push(
      SolanaCollateralTool.planDeposit(
        Actor.User,
        "deposit-solana",
        `deposit ${Constants.BondAmount} lamports SOL producer collateral`,
        outpostWriteStepOptions,
        Constants.ProducerLabel,
        OperatorType.PRODUCER,
        BigInt(Constants.SolanaTokenCode),
        Constants.BondAmount
      ),
      verifyStep(
        Actor.Sysio,
        "depot-status-active",
        "the producer flips OPERATOR_STATUS_ACTIVE once both bonds are posted",
        async ctx => {
          await pollUntil(
            "depot producer status = ACTIVE",
            () => isOperatorActive(ctx),
            Constants.relayDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        relayStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "collateral-scores-the-producer",
        "the bond moves the producer's rank_score into the healthy tier",
        async ctx => {
          // The score is what ranking ORDERS on, and an unscored row sits in the demoted tier
          // where no consumer's walk ever reaches it. `processprod` fires on every balance
          // change precisely so this happens without a governance action — and the TIER is
          // read off the key itself, because `is_demoted` and `is_active` were already false
          // and true the moment the producer registered.
          await pollUntil(
            "producer rank_score in the healthy tier",
            async () => {
              const producer = await readProducerRow(ctx)
              return (
                producer != null &&
                producerTier(producer.rank_score) === ProducerTier.healthy
              )
            },
            Constants.relayDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        relayStepOptions
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
        "regproducer returns eligibility but NOT a clean record: the demotion clears, the miss streak stands",
        async ctx => {
          const producer = await readProducerRow(ctx)
          if (producer == null) {
            throw new Error("the producer's row disappeared after re-registration")
          }
          if (producer.is_demoted) {
            throw new Error("regproducer left the producer demoted")
          }
          // The streak deliberately SURVIVES re-registration. `regproducer` costs nothing but a
          // signature and can be repeated, so clearing the streak here would let an absent
          // operator call it on a timer and never produce a block at all. Only producing clears
          // it, which the next step asserts.
          if (producer.consecutive_missed_rounds === 0) {
            throw new Error(
              "regproducer cleared the miss streak; only producing a block may do that"
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
        "producing-clears-the-streak",
        "the block it just produced is what clears the miss streak",
        async ctx => {
          const producer = await readProducerRow(ctx)
          if (producer == null) {
            throw new Error("the producer's row disappeared after it produced again")
          }
          if (producer.consecutive_missed_rounds !== 0) {
            throw new Error(
              `producing left the miss streak at ${producer.consecutive_missed_rounds}`
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
      "Withdraw the ETH bond; the producer drops below the minimum and leaves the schedule"
    ).push(
      EthereumCollateralTool.planWithdrawal(
        Actor.User,
        "withdraw-ethereum",
        `withdraw the whole ${Constants.WithdrawAmount} wei ETH bond`,
        outpostWriteStepOptions,
        Constants.ProducerLabel,
        BigInt(Constants.EthereumTokenCode),
        Constants.WithdrawAmount
      ),
      verifyStep(
        Actor.Sysio,
        "depot-status-leaves-active",
        "the producer leaves OPERATOR_STATUS_ACTIVE once it is under the per-chain minimum",
        async ctx => {
          // The all-chain rule cuts both ways: falling under the minimum on ANY required chain
          // ends eligibility. `opreg::withdraw` re-evaluating it is WIRE-351 — before that
          // merge the status simply never changed.
          await pollUntil(
            "depot producer status left ACTIVE",
            async () => !(await isOperatorActive(ctx)),
            Constants.relayDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        relayStepOptions
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
  }
}
