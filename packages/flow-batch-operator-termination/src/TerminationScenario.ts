import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterBuildPhase,
  OperatorDaemonArtifactsKey,
  FlowScenario,
  ProtocolTiming,
  Report,
  Steps,
  WireCollateralTool,
  WireOperatorProvisioningTool,
  Constants as DepotConstants,
  getLogger,
  matchesProtoEnum,
  packedSlugValue,
  pollUntil,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { TerminationScenarioConstants as Constants } from "./TerminationScenarioConstants.js"

const log = getLogger(__filename)

const { SysioOpregActiontype, SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report

/** The doomed operator's node-owner-generated WIRE account, resolved from the key store by its label. */
function doomedOperatorAccount(ctx: ClusterBuildContext): string {
  return ctx.keyStore.assertOperator(Constants.DoomedOperatorLabel).account
}

/**
 * The sliding-window schedule groups from the `sysio.epoch::epochstate`
 * singleton (a read) — the WHOLE window, not just the active group: this
 * scenario asserts the doomed operator rides into ANY upcoming group.
 */
async function readScheduleGroups(
  ctx: ClusterBuildContext
): Promise<string[][]> {
  return Steps.contracts.sysio.epoch.batchOperatorGroups(ctx)
}

/**
 * Chain codes (slug numerics) of the doomed operator's success-true
 * WITHDRAW_REMIT audit entries (a read). Termination credits each remitted
 * balance to the operator's claim row and appends a PERMANENT entry to its
 * `recent_actions` ring buffer, so the ring buffer is the audit trail here.
 */
async function readWithdrawRemitChainCodes(
  ctx: ClusterBuildContext
): Promise<Set<number>> {
  const operator = await WireCollateralTool.readOperatorRow(
    ctx,
    Constants.DoomedOperatorLabel
  )
  const remits = (operator?.recent_actions ?? []).filter(
    entry =>
      matchesProtoEnum(
        entry.action?.action_type,
        SysioOpregActiontype,
        SysioOpregActiontype.ACTION_TYPE_WITHDRAW_REMIT
      ) &&
      // ABI-deserialised `success` arrives as numeric 1/0 (bool-as-uint8), not
      // a JS boolean — compare truthiness to match either form.
      Boolean(entry.success)
  )
  return new Set(remits.map(entry => packedSlugValue(entry.action.chain_code)))
}

/**
 * Batch Operator Termination via Delivery Underperformance — verifies the full
 * protocol promise that a non-bootstrapped operator becomes ACTIVE only once its
 * depot-native bond meets the required minimum, and that on termination the
 * whole bond is credited back to it and paid out on `claimremit`:
 *
 * 1. **ChainHealth** — WIRE produces blocks; anvil's `OPP` has
 *    code; the SOL test-validator answers.
 * 2. **ProvisionOperator** — the ONE provisioning mechanism creates the doomed
 *    operator (unique WIRE key, ETH + SOL identities, authex links,
 *    `regoperator(is_bootstrapped=false)`). Bootstrapped operators bypass the
 *    termination machinery, so non-bootstrapped is the point.
 * 3. **VerifyRegistration** — the row exists, non-bootstrapped, status UNKNOWN
 *    (no deposits yet — every `available(...)` in `meets_role_min` is 0).
 * 4. **DepositBelowMinimum** — `sysio` funds the operator and it bonds half the
 *    `(WIRE, WIRE)` minimum through `opreg::deposit`; the balance row holds it
 *    and the status STAYS UNKNOWN.
 * 5. **DepositToMinimum** — the rest of the bond crosses the minimum and the
 *    operator flips ACTIVE in the same transaction.
 * 6. **AccumulateMisses** — `advance`'s new-tail computation folds the operator
 *    into `epochstate.batch_op_groups`. Its daemon is DELIBERATELY never
 *    started, so every scheduled epoch records `recorddel(delivered=false)`.
 * 7. **Terminate** — after ≥ `terminateMaxConsecutiveMisses` consecutive missed
 *    epochs, `termcheck` flips TERMINATED with `terminated_at > 0` and a
 *    populated `status_reason`.
 * 8. **ClaimBond** — termination remits the whole bond inside `termcheck`: a
 *    success-true WITHDRAW_REMIT audit entry lands for the WIRE chain, the
 *    balance row is emptied, and `remitclaims{operator, WIRE}` holds exactly the
 *    bond. `opreg::claimremit` then pays it out: the operator's liquid WIRE
 *    rises by exactly the bond and the claim row is gone.
 */
export class TerminationScenario extends FlowScenario {
  readonly name = "flow-batch-operator-termination"
  readonly description =
    "Non-bootstrapped batch operator bonds WIRE on the depot, misses its scheduled deliveries, is terminated, and claims its bond back"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    batchOperatorCount: Constants.BatchOperatorCount,
    terminateMaxConsecutiveMisses: Constants.TerminateMaxConsecutiveMisses,
    // Without a requirement `meets_role_min` refuses every non-bootstrapped
    // batch operator, so the UNKNOWN → ACTIVE assertions are meaningful only
    // against a minimum the flow installs.
    requiredBatchOperatorCollateral: [
      WireCollateralTool.createWireRequirement(Constants.MinimumBond)
    ]
  }

  plan(cluster: ClusterBuild): void {
    const quickStepOptions = { timeoutMs: Constants.QuickVerifyTimeoutMs },
      scheduleWindowStepOptions = {
        timeoutMs:
          Constants.scheduleWindowDeadlineMs() +
          ProtocolTiming.PollDeadlineBufferMs
      },
      terminationStepOptions = {
        timeoutMs:
          Constants.terminationDeadlineMs() +
          ProtocolTiming.PollDeadlineBufferMs
      },
      // The same epoch duration the claim verify's runner reads (`ctx.config.epochDurationSec`).
      remitClaimStepOptions = {
        timeoutMs: WireCollateralTool.remitClaimStepTimeoutMs(
          cluster.context.config.epochDurationSec
        )
      }

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
      "Provision the doomed non-bootstrapped batch operator (no daemon — it must miss)",
      {},
      [
        {
          label: Constants.DoomedOperatorLabel,
          type: OperatorType.BATCH,
          ethereumHdIndex: Constants.DoomedOperatorEthereumHdIndex,
          isBootstrapped: false
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
        async ctx => {
          const operator = await WireCollateralTool.readOperatorRow(
            ctx,
            Constants.DoomedOperatorLabel
          )
          Assert.ok(
            operator != null,
            `${Constants.DoomedOperatorLabel} missing from sysio.opreg::operators`
          )
          Assert.ok(
            !operator.is_bootstrapped,
            `${Constants.DoomedOperatorLabel} registered bootstrapped — it would bypass termination`
          )
          Assert.ok(
            matchesProtoEnum(
              operator.status,
              SysioOpregOperatorstatus,
              SysioOpregOperatorstatus.OPERATOR_STATUS_UNKNOWN
            ),
            `${Constants.DoomedOperatorLabel} status not UNKNOWN (got ${operator.status})`
          )
        },
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
      verifyStep(
        Actor.Sysio,
        "below-minimum-stays-unknown",
        "status stays UNKNOWN while the bond is under the minimum",
        async ctx => {
          const operator = await WireCollateralTool.readOperatorRow(
            ctx,
            Constants.DoomedOperatorLabel
          )
          Assert.ok(
            operator != null &&
              matchesProtoEnum(
                operator.status,
                SysioOpregOperatorstatus,
                SysioOpregOperatorstatus.OPERATOR_STATUS_UNKNOWN
              ),
            `${Constants.DoomedOperatorLabel} flipped past UNKNOWN below the minimum (got ${operator?.status})`
          )
        },
        quickStepOptions
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
      verifyStep(
        Actor.Sysio,
        "depot-status-active",
        "the bond meets the minimum → status is OPERATOR_STATUS_ACTIVE",
        async ctx => {
          // `deposit` re-evaluates eligibility inline, so one read after its Step is final.
          const operator = await WireCollateralTool.readOperatorRow(
            ctx,
            Constants.DoomedOperatorLabel
          )
          Assert.ok(
            operator != null &&
              matchesProtoEnum(
                operator.status,
                SysioOpregOperatorstatus,
                SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
              ),
            `${Constants.DoomedOperatorLabel} is not ACTIVE with the minimum bonded (got ${operator?.status})`
          )
        },
        quickStepOptions
      )
    )

    // ── 6. In rotation but silent → recorddel buffers consecutive misses ──
    ClusterBuildPhase.create(
      cluster,
      "AccumulateMisses",
      "Operator scheduled but silent (no daemon) — consecutive misses accrue"
    ).push(
      verifyStep(
        Actor.Sysio,
        "enters-schedule-window",
        "operator rides into epochstate.batch_op_groups via advance's new-tail computation",
        async ctx => {
          await pollUntil(
            `${Constants.DoomedOperatorLabel} appears in epochstate.batch_op_groups`,
            async () => {
              try {
                const account = doomedOperatorAccount(ctx),
                  groups = await readScheduleGroups(ctx)
                return groups.some(
                  members => Array.isArray(members) && members.includes(account)
                )
              } catch (error) {
                // Transient RPC failure mid-advance — log it and keep polling.
                log.warn(
                  `[${this.name}] epochstate read failed: ${error instanceof Error ? error.message : String(error)}`
                )
                return false
              }
            },
            Constants.scheduleWindowDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        scheduleWindowStepOptions
      )
    )

    // ── 7. termcheck fires → TERMINATED with audit fields populated ──
    ClusterBuildPhase.create(
      cluster,
      "Terminate",
      "After the miss window, termcheck flips status to TERMINATED"
    ).push(
      verifyStep(
        Actor.Sysio,
        "status-terminated",
        `status flips TERMINATED after ≥${Constants.TerminateMaxConsecutiveMisses} consecutive missed scheduled epochs`,
        async ctx => {
          await pollUntil(
            `${Constants.DoomedOperatorLabel} status flips to TERMINATED`,
            async () => {
              const operator = await WireCollateralTool.readOperatorRow(
                ctx,
                Constants.DoomedOperatorLabel
              )
              return (
                operator != null &&
                matchesProtoEnum(
                  operator.status,
                  SysioOpregOperatorstatus,
                  SysioOpregOperatorstatus.OPERATOR_STATUS_TERMINATED
                )
              )
            },
            Constants.terminationDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        terminationStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "termination-row-populated",
        "terminated_at > 0 and status_reason non-empty on the operator row",
        async ctx => {
          const operator = await WireCollateralTool.readOperatorRow(
            ctx,
            Constants.DoomedOperatorLabel
          )
          Assert.ok(
            operator != null,
            `${Constants.DoomedOperatorLabel} missing from sysio.opreg::operators`
          )
          Assert.ok(
            matchesProtoEnum(
              operator.status,
              SysioOpregOperatorstatus,
              SysioOpregOperatorstatus.OPERATOR_STATUS_TERMINATED
            ),
            `${Constants.DoomedOperatorLabel} status not TERMINATED (got ${operator.status})`
          )
          Assert.ok(
            Number(operator.terminated_at) > 0,
            `terminated_at not populated (got ${operator.terminated_at})`
          )
          Assert.ok(
            typeof operator.status_reason === "string" &&
              operator.status_reason.length > 0,
            `status_reason not populated (got ${JSON.stringify(operator.status_reason)})`
          )
        },
        quickStepOptions
      )
    )

    // ── 8. Termination credited the whole bond to the WIRE claim; claimremit pays it ──
    ClusterBuildPhase.create(
      cluster,
      "ClaimBond",
      "Termination credits the bond to remitclaims; claimremit pays it to the operator"
    ).push(
      verifyStep(
        Actor.Sysio,
        "depot-records-withdraw-remit",
        "recent_actions carries a success-true WITHDRAW_REMIT audit entry for the WIRE chain",
        async ctx => {
          const chainCodes = await readWithdrawRemitChainCodes(ctx)
          Assert.ok(
            chainCodes.has(DepotConstants.WireChainCode),
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
