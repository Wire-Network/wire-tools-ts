import { SysioContracts } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterBuildPhase,
  EthereumCollateralTool,
  FlowScenario,
  ProducerNodeTool,
  Report,
  SolanaCollateralTool,
  Steps,
  WireOperatorProvisioningTool,
  matchesProtoEnum,
  pollUntil,
  slugValue,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { ProducerRegistrationScenarioConstants as Constants } from "./ProducerRegistrationScenarioConstants.js"

const { SysioContractName, SysioOpregOperatorstatus } = SysioContracts
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
    { rows } = await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .tables.operators.query({ limit: 100 })
  return rows.find(row => row.account === account)
}

/** The flow producer's row on `sysio::producers` (a read). */
async function readProducerRow(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioSystemProducerInfoType> {
  const account = producerAccount(ctx),
    { rows } = await ctx.wire
      .getSysioContract(SysioContractName.system)
      .tables.producers.query({ limit: 200 })
  return rows.find(row => row.owner === account)
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

/**
 * Block Producer Registration — a fresh account driven from provisioning all the way to
 * producing blocks, then out of the schedule and back:
 *
 * 1. **ProvisionProducer** — the ONE provisioning mechanism creates the account (unique WIRE
 *    key + its own finalizer key, ETH + SOL identities, authex links, `regoperator`). No
 *    `producerNodeIndex`, so it takes the collateral-backed route, not the genesis one.
 * 2. **NegativeCase** — `regproducer` + `regfinkey` BEFORE any collateral. Asserted here rather
 *    than after the deposits so the ordering is unambiguous: registration alone must NOT make a
 *    producer schedulable.
 * 3. **DepositEthereum** / 4. **DepositSolana** — bond on both outposts; the all-chain rule is
 *    met and the operator flips ACTIVE.
 * 5. **StartProducerNode** — its own nodeop, peered into the mesh.
 * 6. **EntersSchedule** — it enters the ranked schedule and PRODUCES A BLOCK. This is also the
 *    first end-to-end coverage anywhere of the `regfinkey` → `set_proposed_finalizers` path; a
 *    cluster otherwise installs finality directly at genesis.
 * 7. **MissedRounds** — its node is stopped (a controlled stop; the flow owns the process). The
 *    miss counter climbs, demotion fires at exactly the configured threshold, and it leaves the
 *    schedule while the schedule stays at or above `min_schedule_size`.
 * 8. **Recover** — the node restarts and `regproducer` clears the demotion. It re-enters the
 *    schedule and produces again.
 * 9. **Removal** — the whole ETH bond is withdrawn. The operator drops below the per-chain
 *    minimum, leaves ACTIVE, and its rank position goes with it — the collateral-driven exit
 *    that mirrors the collateral-driven entry in phases 3-4. This depends on `opreg::withdraw`
 *    re-evaluating eligibility (WIRE-351, wire-sysio PR #589).
 */
export class ProducerRegistrationScenario extends FlowScenario {
  readonly name = "flow-producer-registration"
  readonly description =
    "A fresh account registers as a producer, bonds collateral, enters the ranked schedule, is demoted for missed rounds, and recovers"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    // One producer ACCOUNT per producer NODE — see the constants' note on why the two counts
    // are set equal, and why five rather than the `min_schedule_size` floor of four.
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
        timeoutMs: Constants.relayDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      scheduleStepOptions = {
        timeoutMs:
          Constants.scheduleDeadlineMs(ScheduleSize) +
          Constants.PollDeadlineBufferMs
      },
      demotionStepOptions = {
        timeoutMs:
          Constants.demotionDeadlineMs(ScheduleSize) +
          Constants.PollDeadlineBufferMs
      }

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
        Constants.ProducerRamBytes
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
        "unbonded-producer-stays-unknown",
        "a registered but unbonded producer stays UNKNOWN and produces nothing",
        async ctx => {
          // Held across a full schedule-rebuild window: `update_ranked_producers` fires roughly
          // once a minute, so a shorter check would pass merely because no rebuild had run.
          const deadline =
            Date.now() + Constants.scheduleDeadlineMs(ScheduleSize)
          while (Date.now() < deadline) {
            const operator = await readOperatorRow(ctx)
            if (
              operator != null &&
              matchesProtoEnum(
                operator.status,
                SysioOpregOperatorstatus,
                SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
              )
            ) {
              throw new Error(
                "an unbonded producer reached OPERATOR_STATUS_ACTIVE — meets_role_min let an empty bond through"
              )
            }
            if (await hasProducedBlock(ctx)) {
              throw new Error(
                "an unbonded producer produced a block — it was scheduled without collateral"
              )
            }
            await new Promise(resolve =>
              setTimeout(resolve, Constants.PollIntervalMs)
            )
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
        { timeoutMs: 60_000 },
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
                  slugValue(balance.chain_code) ===
                    Constants.EthereumChainCode &&
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

    // ── 4. SOL bond → all-chain rule met → ACTIVE ──
    ClusterBuildPhase.create(
      cluster,
      "DepositSolana",
      "Bond SOL collateral; the producer operator flips ACTIVE"
    ).push(
      SolanaCollateralTool.planDeposit(
        Actor.User,
        "deposit-solana",
        `deposit ${Constants.BondAmount} lamports SOL producer collateral`,
        { timeoutMs: 60_000 },
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
            async () => {
              const operator = await readOperatorRow(ctx)
              return (
                operator != null &&
                matchesProtoEnum(
                  operator.status,
                  SysioOpregOperatorstatus,
                  SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
                )
              )
            },
            Constants.relayDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        relayStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "collateral-scores-the-producer",
        "the bond moves the producer out of the unscored demoted tier",
        async ctx => {
          // The score is what ranking ORDERS on, and an unscored row sits in the demoted tier
          // where no consumer's walk ever reaches it. `processprod` fires on every balance
          // change precisely so this happens without a governance action.
          await pollUntil(
            "producer rank_score left the demoted tier",
            async () => {
              const producer = await readProducerRow(ctx)
              return (
                producer != null && !producer.is_demoted && producer.is_active
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

    // ── 7. Stop its node; misses accrue; demotion fires ──
    ClusterBuildPhase.create(
      cluster,
      "MissedRounds",
      "Stop the producer's node; misses accrue and demotion fires"
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
          // Exactly the threshold, not merely "at least": demoting early would evict a producer
          // that had not yet earned it.
          if (
            demoted.consecutive_missed_rounds <
            Constants.MaxConsecutiveMissedRounds
          ) {
            throw new Error(
              `demoted at ${demoted.consecutive_missed_rounds} misses, below the configured ${Constants.MaxConsecutiveMissedRounds}`
            )
          }
        },
        demotionStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "schedule-holds-above-the-floor",
        "the genesis producers keep producing while the demoted one is out",
        async ctx => {
          // The floor is the point: a demotion must never take the schedule below
          // `min_schedule_size`, because below it `update_ranked_producers` retains the last
          // good schedule and the demoted producer would keep producing.
          const account = producerAccount(ctx)
          await pollUntil(
            "a genesis producer holds the head block",
            async () => {
              const { head_block_producer } = await ctx.wire.getInfo()
              return head_block_producer !== account
            },
            Constants.scheduleDeadlineMs(ScheduleSize),
            Constants.PollIntervalMs
          )
        },
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
        "regproducer clears is_demoted and the miss counter, with no waiting period",
        async ctx => {
          const producer = await readProducerRow(ctx)
          if (producer == null) {
            throw new Error("the producer's row disappeared after re-registration")
          }
          if (producer.is_demoted || producer.consecutive_missed_rounds !== 0) {
            throw new Error(
              `regproducer left the producer demoted=${producer.is_demoted} misses=${producer.consecutive_missed_rounds}`
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
        { timeoutMs: 60_000 },
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
            async () => {
              const operator = await readOperatorRow(ctx)
              return (
                operator != null &&
                !matchesProtoEnum(
                  operator.status,
                  SysioOpregOperatorstatus,
                  SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
                )
              )
            },
            Constants.relayDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        relayStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "unbonded-producer-leaves-the-schedule",
        "a genesis producer reclaims the slot and the schedule never drops below the floor",
        async ctx => {
          // No `is_op_active` row means no rank position, so the next rebuild drops it. The
          // schedule stays live throughout: five genesis producers is one above
          // `min_schedule_size`, so this removal is absorbed rather than freezing the schedule.
          const account = producerAccount(ctx)
          await pollUntil(
            "a genesis producer holds the head block after the removal",
            async () => {
              const { head_block_producer } = await ctx.wire.getInfo()
              return head_block_producer !== account
            },
            Constants.scheduleDeadlineMs(ScheduleSize),
            Constants.PollIntervalMs
          )
        },
        scheduleStepOptions
      )
    )
  }
}
