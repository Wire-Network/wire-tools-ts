import Assert from "node:assert"

import { OperatorType } from "@wireio/opp-typescript-models"
import { SysioContracts } from "@wireio/sdk-core"

import {
  describeOutpostChains,
  mapOutpostChains,
  OutpostChainCodenames
} from "@wireio/cluster-tool-shared"
import {
  BatchOperatorSchedule,
  ClusterBuildPhase,
  Constants as HarnessConstants,
  FlowScenario,
  OperatorDaemonArtifactsKey,
  ProtocolTiming,
  Report,
  Steps,
  WireCollateralTool,
  WireOperatorProvisioningTool,
  getLogger,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"

import { TerminationScenarioConstants as Constants } from "./TerminationScenarioConstants.js"
import { TerminationSteps } from "./steps/index.js"

const log = getLogger(__filename)

const { SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report

/**
 * Batch Operator Eviction via Delivery Underperformance — verifies that a
 * non-bootstrapped operator becomes ACTIVE only once its depot-native bond meets
 * the required minimum, that missing its seats on the chain it serves evicts it
 * from THAT chain alone (its status and bond untouched), and that governance's
 * global `terminate` is what credits the whole bond back for `claimremit`:
 *
 * 1. **ChainHealth** — WIRE produces blocks; anvil's `OPP` has
 *    code; the SOL test-validator answers.
 * 2. **ProvisionOperator** — the ONE provisioning mechanism creates the doomed
 *    operator (unique WIRE key, ETH + SOL identities, authex links,
 *    `regoperator(is_bootstrapped=false)`) and joins it to the missed chain
 *    only. Bootstrapped operators bypass the miss rails, so non-bootstrapped is
 *    the point.
 * 3. **VerifyRegistration** — the row exists, non-bootstrapped, status UNKNOWN
 *    (no deposits yet — every `available(...)` in `meets_role_min` is 0); it
 *    SERVES the missed chain and has no membership of the other.
 * 4. **DepositBelowMinimum** — `sysio` funds the operator and it bonds half the
 *    `(WIRE, WIRE)` minimum through `opreg::deposit`; the balance row holds it
 *    and the status STAYS UNKNOWN.
 * 5. **DepositToMinimum** — the rest of the bond crosses the minimum and the
 *    operator flips ACTIVE in the same transaction.
 * 6. **AccumulateMisses** — the missed chain's `advance` folds the operator into
 *    its `epochstate.batch_op_groups`. Its daemon is DELIBERATELY never started,
 *    so every scheduled epoch of the chain records `recorddel(delivered=false)`
 *    when that epoch's books close: once the next epoch's late window has
 *    passed, or at the advance after it.
 *
 * Epochs are depot-paced and the flow queues nothing to either outpost, so every
 * duty epoch of the missed chain, and both chains' post-eviction rotation, are
 * driven by keep-due traffic (`sysio.epoch::notetraffic`) the keep-due pump
 * gives a chain whenever it is idle during the waits that need it to advance.
 * 7. **EvictFromChain** — once its first `terminateMinimumPercentSamples` duty
 *    epochs are all missed (a 100 % miss rate the moment the percent rail
 *    applies), the `termcheck(account, chain)` of the advance that closes the
 *    last one's books flips the chain membership EVICTED with a populated
 *    `status_reason`, while the operator stays ACTIVE with `terminated_at` 0, its
 *    bond still in the balance row, no remit, and no membership of the other chain.
 * 8. **ContinuedRotation** — the seat the missed chain's window drew for the
 *    operator before its eviction slides out and no later group seats it; with
 *    sufficient standing operators, ordinary rotation then fills every duty seat,
 *    excludes the evicted operator from every published window, and both outposts
 *    accept another complete rotation of their own chain.
 * 9. **GovernanceTermination** — `sysio.opreg::terminate` (governance) flips the
 *    operator TERMINATED with `terminated_at > 0` and its reason, remits the whole
 *    bond (a success-true WITHDRAW_REMIT for the WIRE chain, the balance row
 *    emptied, `remitclaims{operator, WIRE}` holding exactly the bond), and
 *    `opreg::claimremit` pays it: the operator's liquid WIRE rises by exactly the
 *    bond and the claim row is gone.
 */
export class TerminationScenario extends FlowScenario {
  readonly name = "flow-batch-operator-termination"
  readonly description =
    "Batch operator bonds WIRE on the depot, is evicted from the chain it misses while staying ACTIVE with its bond, standing operators keep both outposts advancing, and governance termination pays the bond back"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    batchOperatorCount: Constants.BatchOperatorCount,
    terminateMaxConsecutiveMisses: Constants.TerminateMaxConsecutiveMisses,
    terminateMinimumPercentSamples: Constants.TerminateMinimumPercentSamples,
    // Without a requirement `meets_role_min` refuses every non-bootstrapped
    // batch operator, so the UNKNOWN → ACTIVE assertions are meaningful only
    // against a minimum the flow installs.
    requiredBatchOperatorCollateral: [
      WireCollateralTool.createWireRequirement(Constants.MinimumBond)
    ]
  }

  plan(cluster: ClusterBuild): void {
    const { config } = cluster.context,
      quickStepOptions = { timeoutMs: Constants.QuickVerifyTimeoutMs },
      scheduleWindowStepOptions = ProtocolTiming.pollStepOptions(Constants.scheduleWindowDeadlineMs()),
      terminationStepOptions = ProtocolTiming.pollStepOptions(Constants.terminationDeadlineMs()),
      evictedSeatStepOptions = ProtocolTiming.pollStepOptions(Constants.evictedSeatDeadlineMs()),
      // The same config the claim verify's runner reads (`ctx.config`).
      remitClaimStepOptions = {
        timeoutMs: WireCollateralTool.remitClaimStepTimeoutMs(config)
      },
      // Each chain's window holds the configured group count (`epochcfg.batch_op_groups`).
      rotationStepOptions = ProtocolTiming.pollStepOptions(
        TerminationSteps.rotationDeadlineMs(
          config,
          mapOutpostChains(() => BatchOperatorSchedule.resolve(config).batchOpGroups)
        )
      )

    // ── 1. Substrate health (WIRE / ETH outpost / SOL validator) ──
    ClusterBuildPhase.create(
      cluster,
      "ChainHealth",
      "The three chains answer before the scenario begins"
    ).push(
      verifyStep(
        Actor.Sysio,
        "wire-produces-blocks",
        "WIRE chain is producing blocks",
        async ctx => {
          const info = await ctx.wire.getInfo()
          Assert.ok(
            Number(info.head_block_num) > 0,
            `WIRE head_block_num not advancing (got ${info.head_block_num})`
          )
        },
        quickStepOptions
      ),
      verifyStep(
        Actor.EthereumOutpost,
        "ethereum-outpost-reachable",
        "anvil answers and OPP has deployed code",
        async ctx => {
          const address = ctx.outputs.assert(OperatorDaemonArtifactsKey)
            .ethereumAddresses.OPP
          const code = await ctx.ethereum.provider.getCode(address)
          Assert.ok(
            code.length > Constants.MinimumContractCodeLength,
            `OPP has no code on anvil (getCode returned ${code.length} chars)`
          )
        },
        quickStepOptions
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "solana-validator-reachable",
        "solana-test-validator answers getSlot",
        async ctx => {
          const slot = await ctx.solana.connection.getSlot()
          Assert.ok(
            slot > 0,
            `solana-test-validator slot not advancing (got ${slot})`
          )
        },
        quickStepOptions
      )
    )

    // ── 2. Provision the doomed non-bootstrapped operator (the ONE mechanism).
    //       Its daemon is DELIBERATELY never started — the whole flow depends on
    //       the scheduled operator staying silent so misses accumulate. ──
    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      cluster,
      "ProvisionOperator",
      `Provision the doomed non-bootstrapped batch operator serving ${Constants.MissedChain} (no daemon — it must miss)`,
      {},
      [
        {
          label: Constants.DoomedOperatorLabel,
          type: OperatorType.BATCH,
          isBootstrapped: false,
          servedChains: [Constants.MissedChain]
        }
      ]
    )

    // ── 3. Registration post-conditions (row exists, non-bootstrapped, UNKNOWN) ──
    ClusterBuildPhase.create(
      cluster,
      "VerifyRegistration",
      "The operator row exists non-bootstrapped with status UNKNOWN"
    ).push(
      verifyStep(
        Actor.Sysio,
        "registered-status-unknown",
        "operator registered non-bootstrapped with status UNKNOWN (no deposits yet)",
        async ctx =>
          TerminationSteps.assertRegisteredUnbootstrapped(
            await WireCollateralTool.readOperatorRow(ctx, Constants.DoomedOperatorLabel)
          ),
        quickStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "serves-missed-chain-only",
        `the operator SERVES ${Constants.MissedChain} and has no ${Constants.UnservedChain} membership`,
        async ctx =>
          TerminationSteps.assertServesMissedChainOnly(
            await TerminationSteps.readDoomedMembership(ctx, Constants.MissedChain),
            await TerminationSteps.readDoomedMembership(ctx, Constants.UnservedChain)
          ),
        quickStepOptions
      )
    )

    // ── 4. Bond half the minimum → balance row; status stays UNKNOWN ──
    ClusterBuildPhase.create(
      cluster,
      "DepositBelowMinimum",
      "Bond half the minimum on the depot; the balance row holds it and the status stays UNKNOWN"
    ).push(
      ...WireCollateralTool.planDeposit(
        Actor.BatchOperator,
        "deposit-below-minimum",
        `bond ${Constants.FirstDepositAmount} WIRE units through sysio.opreg::deposit`,
        {},
        Constants.DoomedOperatorLabel,
        WireCollateralTool.createWireCollateral(Constants.FirstDepositAmount)
      ),
      WireCollateralTool.planVerifyBalanceRow(
        Actor.Sysio,
        "depot-balance-below-minimum",
        `the (WIRE, WIRE) balance row holds exactly ${Constants.FirstDepositAmount}`,
        quickStepOptions,
        Constants.DoomedOperatorLabel,
        WireCollateralTool.createWireCollateral(Constants.FirstDepositAmount)
      ),
      WireCollateralTool.planVerifyOperatorStatus(
        Actor.Sysio,
        "below-minimum-stays-unknown",
        "status stays UNKNOWN while the bond is under the minimum",
        quickStepOptions,
        Constants.DoomedOperatorLabel,
        SysioOpregOperatorstatus.OPERATOR_STATUS_UNKNOWN
      )
    )

    // ── 5. Bond the rest → minimum met → ACTIVE ──
    ClusterBuildPhase.create(
      cluster,
      "DepositToMinimum",
      "Bond the rest; the minimum is met and the operator flips ACTIVE"
    ).push(
      ...WireCollateralTool.planDeposit(
        Actor.BatchOperator,
        "deposit-to-minimum",
        `bond ${Constants.SecondDepositAmount} more WIRE units through sysio.opreg::deposit`,
        {},
        Constants.DoomedOperatorLabel,
        WireCollateralTool.createWireCollateral(Constants.SecondDepositAmount)
      ),
      WireCollateralTool.planVerifyBalanceRow(
        Actor.Sysio,
        "depot-balance-holds-bond",
        `the (WIRE, WIRE) balance row holds exactly ${Constants.BondAmount}`,
        quickStepOptions,
        Constants.DoomedOperatorLabel,
        WireCollateralTool.createWireCollateral(Constants.BondAmount)
      ),
      // `deposit` re-evaluates eligibility inline, so one read after its Step is final.
      WireCollateralTool.planVerifyOperatorStatus(
        Actor.Sysio,
        "depot-status-active",
        "the bond meets the minimum → status is OPERATOR_STATUS_ACTIVE",
        quickStepOptions,
        Constants.DoomedOperatorLabel,
        SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
      )
    )

    // ── 6. In rotation but silent → recorddel buffers consecutive misses ──
    ClusterBuildPhase.create(
      cluster,
      "AccumulateMisses",
      `Operator scheduled on ${Constants.MissedChain} but silent (no daemon) — consecutive misses accrue`
    ).push(
      verifyStep(
        Actor.Sysio,
        "enters-schedule-window",
        `operator rides into the ${Constants.MissedChain} epochstate.batch_op_groups via advance's new-tail computation`,
        async (ctx, signal) =>
          TerminationSteps.awaitMissedChainSeat(ctx, true, Constants.scheduleWindowDeadlineMs(), signal),
        scheduleWindowStepOptions
      )
    )

    // ── 7. termcheck evicts the operator from the missed chain only ──
    ClusterBuildPhase.create(
      cluster,
      "EvictFromChain",
      `After the miss window, termcheck evicts the operator from ${Constants.MissedChain} alone; it stays ACTIVE with its bond`
    ).push(
      verifyStep(
        Actor.Sysio,
        "membership-evicted",
        `the ${Constants.MissedChain} membership flips EVICTED once its first ${Constants.TerminateMinimumPercentSamples} scheduled epochs are all missed`,
        async (ctx, signal) => {
          // Each duty epoch's books close at a later advance, which needs traffic: keep the chain due.
          await Steps.epochAdvance.pollUntilKeepingDue(
            ctx,
            [Constants.MissedChain],
            `${Constants.DoomedOperatorLabel}'s ${Constants.MissedChain} membership flips to EVICTED`,
            async () =>
              TerminationSteps.isEvicted(
                await TerminationSteps.readDoomedMembership(ctx, Constants.MissedChain)
              ),
            Constants.terminationDeadlineMs(),
            Constants.PollIntervalMs,
            signal
          )
        },
        terminationStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "eviction-reason-recorded",
        `the EVICTED ${Constants.MissedChain} membership carries its rail's status_reason; no ${Constants.UnservedChain} membership appeared`,
        async ctx =>
          TerminationSteps.assertEvictionRecorded(
            await TerminationSteps.readDoomedMembership(ctx, Constants.MissedChain),
            await TerminationSteps.readDoomedMembership(ctx, Constants.UnservedChain)
          ),
        quickStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "evicted-operator-stays-active",
        "the operator row stays ACTIVE, not terminated, with no WITHDRAW_REMIT",
        async ctx => {
          const operator = await TerminationSteps.readDoomedOperator(ctx)
          TerminationSteps.assertEvictedOperatorStaysActive(
            operator,
            TerminationSteps.withdrawRemitChainCodes(operator)
          )
        },
        quickStepOptions
      ),
      WireCollateralTool.planVerifyBalanceRow(
        Actor.Sysio,
        "evicted-operator-keeps-bond",
        `the (WIRE, WIRE) balance row still holds exactly the ${Constants.BondAmount} bond`,
        quickStepOptions,
        Constants.DoomedOperatorLabel,
        WireCollateralTool.createWireCollateral(Constants.BondAmount)
      )
    )

    // ── 8. Ordinary rotation keeps delivering with sufficient standing operators ──
    ClusterBuildPhase.create(
      cluster,
      "ContinuedRotation",
      "The seat drawn for the evicted operator before its eviction slides out, then standing operators fill the rotation and both outposts accept another full window of their own chain"
    ).push(
      verifyStep(
        Actor.Sysio,
        "evicted-seat-slides-out",
        `the seat the ${Constants.MissedChain} window drew for the evicted operator before its eviction slides out, and no later group seats it`,
        async (ctx, signal) =>
          TerminationSteps.awaitMissedChainSeat(ctx, false, Constants.evictedSeatDeadlineMs(), signal),
        evictedSeatStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "post-eviction-rotation",
        "published groups exclude the evicted operator and both outposts, each kept due, advance through a full window of their own chain",
        async (ctx, signal) => {
          const evicted = TerminationSteps.doomedOperatorAccount(ctx),
            standing = TerminationSteps.standingOperators(ctx.keyStore.operators, evicted),
            groupSize = BatchOperatorSchedule.resolve(ctx.config).operatorsPerEpoch,
            // Each chain counts its own epochs and runs its own window, so each outpost is held
            // to a full window of its own chain past its own start.
            targets = TerminationSteps.rotationTargets(
              await Steps.contracts.sysio.epoch.readEpochStates(ctx),
              await TerminationSteps.readInboundCursors(ctx)
            )
          await Steps.epochAdvance.pollUntilKeepingDue(
            ctx,
            OutpostChainCodenames,
            `both outposts accept post-eviction epochs through ${describeOutpostChains(targets, target => String(target.targetEpoch))}`,
            async () => {
              const { rows } = await ctx.wire.getOutboundEnvelopes()
              OutpostChainCodenames.forEach(chain =>
                TerminationSteps.publishedWindows(rows, chain).forEach(groups =>
                  TerminationSteps.assertPublishedGroups(
                    chain,
                    groups,
                    targets[chain].groupCount,
                    groupSize,
                    evicted,
                    standing
                  )
                )
              )
              const cursors = await TerminationSteps.readInboundCursors(ctx)
              log.info(
                `[${this.name}] post-eviction next epochs ` +
                  describeOutpostChains(cursors, (cursor, chain) => `${cursor} (target>${targets[chain].targetEpoch})`)
              )
              return OutpostChainCodenames.every(chain => cursors[chain] > targets[chain].targetEpoch)
            },
            TerminationSteps.rotationDeadlineMs(
              ctx.config,
              mapOutpostChains(chain => targets[chain].groupCount)
            ),
            Constants.PollIntervalMs,
            signal
          )
        },
        rotationStepOptions
      )
    )

    // ── 9. Governance terminates globally; the remitted bond is claimed ──
    ClusterBuildPhase.create(
      cluster,
      "GovernanceTermination",
      "Governance terminates the operator globally: the bond is credited to remitclaims and claimremit pays it"
    ).push(
      TerminationSteps.planTermination(
        Actor.Sysio,
        "governance-terminate",
        `governance terminates ${Constants.DoomedOperatorLabel} through sysio.opreg::terminate`,
        {},
        Constants.DoomedOperatorLabel,
        Constants.GovernanceTerminationReason
      ),
      verifyStep(
        Actor.Sysio,
        "termination-row-populated",
        "status TERMINATED, terminated_at > 0 and the governance reason on the operator row",
        async ctx => TerminationSteps.assertTerminationRecorded(await TerminationSteps.readDoomedOperator(ctx)),
        quickStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "depot-records-withdraw-remit",
        "recent_actions carries a success-true WITHDRAW_REMIT audit entry for the WIRE chain",
        async ctx => {
          const chainCodes = TerminationSteps.withdrawRemitChainCodes(await TerminationSteps.readDoomedOperator(ctx))
          Assert.ok(
            chainCodes.has(HarnessConstants.WireChainCode),
            `${Constants.DoomedOperatorLabel} has no success-true WITHDRAW_REMIT for the WIRE chain`
          )
        },
        quickStepOptions
      ),
      WireCollateralTool.planVerifyBalanceRow(
        Actor.Sysio,
        "depot-balance-emptied",
        "the (WIRE, WIRE) balance row is empty after termination",
        quickStepOptions,
        Constants.DoomedOperatorLabel,
        WireCollateralTool.createWireCollateral(0n)
      ),
      WireCollateralTool.planVerifyRemitClaim(
        Actor.Sysio,
        "termination-credits-remit-claim",
        `remitclaims{operator, WIRE} holds exactly the ${Constants.BondAmount} bond`,
        remitClaimStepOptions,
        Constants.DoomedOperatorLabel,
        WireCollateralTool.createWireClaim(Constants.BondAmount)
      ),
      WireCollateralTool.planRecordWireBalance(
        Actor.BatchOperator,
        "record-wire-before-claim",
        "record the terminated operator's liquid WIRE before the claim",
        {},
        Constants.DoomedOperatorLabel
      ),
      WireCollateralTool.planClaimremit(
        Actor.BatchOperator,
        "claimremit-wire",
        "claim the remitted bond through sysio.opreg::claimremit",
        {},
        Constants.DoomedOperatorLabel,
        WireCollateralTool.WireTokenCode
      ),
      WireCollateralTool.planVerifyWireBalanceIncrease(
        Actor.BatchOperator,
        "claim-pays-bond",
        `the operator's liquid WIRE rises by exactly the ${Constants.BondAmount} bond`,
        {},
        Constants.DoomedOperatorLabel,
        Constants.BondAmount
      ),
      WireCollateralTool.planVerifyRemitClaim(
        Actor.Sysio,
        "claim-row-cleared",
        "remitclaims{operator, WIRE} is gone after the payout",
        remitClaimStepOptions,
        Constants.DoomedOperatorLabel,
        WireCollateralTool.createWireClaim(0n)
      )
    )
  }
}
