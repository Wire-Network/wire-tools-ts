import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterBuildPhase,
  FlowScenario,
  OperatorDaemonTool,
  Report,
  WireCollateralTool,
  WireOperatorProvisioningTool,
  matchesProtoEnum,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { CollateralLifecycleScenarioConstants as Constants } from "./CollateralLifecycleScenarioConstants.js"

const { SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report


/** The depositor's node-owner-generated WIRE account, resolved from the key store by its label. */
function depositorAccount(ctx: ClusterBuildContext): string {
  return ctx.keyStore.assertOperator(Constants.DepositorLabel).account
}

/**
 * Assert the depositor's operator row is `OPERATOR_STATUS_ACTIVE`. One read: `deposit` and
 * `withdraw` re-evaluate eligibility inline, so the status the write set is already final
 * when its Step returns.
 */
async function assertDepositorActive(ctx: ClusterBuildContext): Promise<void> {
  const operator = await WireCollateralTool.readOperatorRow(ctx, Constants.DepositorLabel)
  Assert.ok(operator != null, `${Constants.DepositorLabel} missing from sysio.opreg::operators`)
  Assert.ok(
    matchesProtoEnum(
      operator.status,
      SysioOpregOperatorstatus,
      SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
    ),
    `${Constants.DepositorLabel} status is ${operator.status}, expected OPERATOR_STATUS_ACTIVE`
  )
}

/**
 * Node Operator Collateral Deposit — the full depot-native collateral lifecycle for a
 * NON-bootstrapped batch operator, on `sysio.opreg`:
 *
 * 1. **ProvisionDepositor** — the ONE provisioning mechanism creates `depositor` (unique WIRE
 *    key, ETH + SOL identities, authex links, `regoperator`).
 * 2. **DepositorDaemon** — its batch-operator daemon (required once ACTIVE: the schedule
 *    prefers non-bootstrapped operators, and its group must relay).
 * 3. **Deposit** — `sysio` funds the depositor with WIRE and the depositor bonds it through
 *    `opreg::deposit`; the `(WIRE, WIRE)` balance row holds the bond and the operator is
 *    ACTIVE.
 * 4. **WithdrawRequest** — `opreg::withdraw` queues half the bond; the remainder still meets
 *    the minimum, so the operator stays ACTIVE.
 * 5. **WaitAndFlush** — after the withdraw wait, `flushwtdw` (inline from
 *    `sysio.epoch::advance`) drains the queue row, debits the balance row and credits
 *    `remitclaims{depositor, WIRE}`.
 * 6. **ClaimRemit** — `opreg::claimremit` pays the claim out through `sysio.token`; the
 *    depositor's liquid WIRE rises by exactly the withdrawal and the claim row is gone.
 */
export class CollateralLifecycleScenario extends FlowScenario {
  readonly name = "flow-operator-collateral-deposit"
  readonly description =
    "Operator bonds WIRE on the depot, withdraws half the bond, and claims the matured withdrawal"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    // One daemon started outside `NodeConfig.plan` — its ports are reserved with every planned
    // node so they reach the port registry, rather than being picked when it spawns.
    adHocCount: Constants.AdHocDaemonCount,
    // Without a requirement `meets_role_min` refuses every non-bootstrapped batch operator,
    // so the ACTIVE assertion is meaningful only against a minimum the flow installs.
    requiredBatchOperatorCollateral: [WireCollateralTool.createWireRequirement(Constants.MinimumBond)]
  }

  plan(cluster: ClusterBuild): void {
    // The same epoch duration the claim verify's runner reads (`ctx.config.epochDurationSec`),
    // so the Step ceiling cannot diverge from the poll deadline it wraps.
    const remitClaimStepOptions = {
        timeoutMs: WireCollateralTool.remitClaimStepTimeoutMs(cluster.context.config.epochDurationSec)
      }

    // ── 1. Provision the non-bootstrapped depositor (the ONE mechanism) ──
    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      cluster,
      "ProvisionDepositor",
      "Provision the non-bootstrapped depositor batch operator",
      {},
      [
        {
          label: Constants.DepositorLabel,
          type: OperatorType.BATCH,
          ethereumHdIndex: Constants.DepositorEthereumHdIndex,
          isBootstrapped: false,
          airdropSolanaLamports: Constants.DepositorAirdropLamports
        }
      ]
    )

    // ── 2. The depositor's daemon (schedule-relay requirement once ACTIVE) ──
    ClusterBuildPhase.create(
      cluster,
      "DepositorDaemon",
      "Start the depositor's batch-operator daemon"
    ).push(
      OperatorDaemonTool.planDaemonStart(
        Actor.BatchOperator,
        "start-depositor-daemon",
        `start ${Constants.DepositorLabel}'s batch-operator daemon`,
        {},
        Constants.DepositorLabel
      )
    )

    // ── 3. Fund + bond WIRE on the depot → balance row, ACTIVE ──
    ClusterBuildPhase.create(
      cluster,
      "Deposit",
      "Bond WIRE on the depot; the balance row holds the bond and the operator is ACTIVE"
    ).push(
      ...WireCollateralTool.planDeposit(
        Actor.BatchOperator,
        "deposit-wire",
        `bond ${Constants.BondAmount} WIRE units through sysio.opreg::deposit`,
        {},
        Constants.DepositorLabel,
        WireCollateralTool.createWireCollateral(Constants.BondAmount)
      ),
      WireCollateralTool.planVerifyBalanceRow(
        Actor.Sysio,
        "depot-balance-holds-bond",
        `the (WIRE, WIRE) balance row holds exactly ${Constants.BondAmount}`,
        {},
        Constants.DepositorLabel,
        WireCollateralTool.createWireCollateral(Constants.BondAmount)
      ),
      verifyStep(
        Actor.Sysio,
        "depot-status-active",
        "the bond meets the batch-operator minimum; the operator is OPERATOR_STATUS_ACTIVE",
        assertDepositorActive
      )
    )

    // ── 4. Withdraw half the bond → depot queues it ──
    ClusterBuildPhase.create(
      cluster,
      "WithdrawRequest",
      "Withdraw half the bond; the depot queues it in wtdwqueue"
    ).push(
      // The runner fails the Step unless a new wtdwqueue row for exactly this amount appears.
      WireCollateralTool.planWithdrawal(
        Actor.BatchOperator,
        "withdraw-wire",
        `withdraw ${Constants.WithdrawAmount} WIRE units of the bond`,
        {},
        Constants.DepositorLabel,
        WireCollateralTool.createWireCollateral(Constants.WithdrawAmount)
      ),
      verifyStep(
        Actor.Sysio,
        "remainder-keeps-active",
        "the remainder meets the minimum; the operator stays OPERATOR_STATUS_ACTIVE",
        assertDepositorActive
      )
    )

    // ── 5. Wait window elapses; flushwtdw matures the withdrawal into a claim ──
    ClusterBuildPhase.create(
      cluster,
      "WaitAndFlush",
      "After the withdraw wait, flushwtdw debits the balance row and credits remitclaims"
    ).push(
      WireCollateralTool.planVerifyRemitClaim(
        Actor.Sysio,
        "flush-credits-remit-claim",
        `remitclaims{depositor, WIRE} holds exactly ${Constants.WithdrawAmount}`,
        remitClaimStepOptions,
        Constants.DepositorLabel,
        WireCollateralTool.createWireClaim(Constants.WithdrawAmount)
      ),
      verifyStep(
        Actor.Sysio,
        "flush-drains-queue",
        "the matured wtdwqueue row is gone",
        async ctx => {
          const requests = await WireCollateralTool.readWithdrawRequests(
            ctx,
            depositorAccount(ctx)
          )
          Assert.ok(
            requests.length === 0,
            `${Constants.DepositorLabel} still has ${requests.length} wtdwqueue row(s) after the flush`
          )
        }
      ),
      WireCollateralTool.planVerifyBalanceRow(
        Actor.Sysio,
        "depot-balance-debited",
        `the (WIRE, WIRE) balance row holds exactly ${Constants.ExpectedRemainingBalance}`,
        {},
        Constants.DepositorLabel,
        WireCollateralTool.createWireCollateral(Constants.ExpectedRemainingBalance)
      )
    )

    // ── 6. claimremit pays the claim out through sysio.token ──
    ClusterBuildPhase.create(
      cluster,
      "ClaimRemit",
      "claimremit pays the matured withdrawal to the depositor's WIRE balance"
    ).push(
      WireCollateralTool.planRecordWireBalance(
        Actor.BatchOperator,
        "record-wire-before-claim",
        "record the depositor's liquid WIRE before the claim",
        {},
        Constants.DepositorLabel
      ),
      WireCollateralTool.planClaimremit(
        Actor.BatchOperator,
        "claimremit-wire",
        "claim the matured withdrawal through sysio.opreg::claimremit",
        {},
        Constants.DepositorLabel,
        WireCollateralTool.WireTokenCode
      ),
      WireCollateralTool.planVerifyWireBalanceIncrease(
        Actor.BatchOperator,
        "claim-pays-withdrawal",
        `the depositor's liquid WIRE rises by exactly ${Constants.WithdrawAmount}`,
        {},
        Constants.DepositorLabel,
        Constants.WithdrawAmount
      ),
      WireCollateralTool.planVerifyRemitClaim(
        Actor.Sysio,
        "claim-row-cleared",
        "remitclaims{depositor, WIRE} is gone after the payout",
        remitClaimStepOptions,
        Constants.DepositorLabel,
        WireCollateralTool.createWireClaim(0n)
      )
    )
  }
}
