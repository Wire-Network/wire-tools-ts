import { SysioContracts } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterBuildPhase,
  EthereumCollateralTool,
  FlowScenario,
  OperatorDaemonTool,
  Report,
  SolanaCollateralTool,
  WireOperatorProvisioningTool,
  matchesProtoEnum,
  pollUntil,
  slugValue,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { CollateralLifecycleScenarioConstants as Constants } from "./CollateralLifecycleScenarioConstants.js"

const { SysioContractName, SysioOpregOperatorstatus } = SysioContracts
const { Actor } = Report

/** The depositor's operator row on `sysio.opreg::operators` (a read). */
async function readDepositorRow(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioOpregOperatorEntryType> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.opreg)
    .tables.operators.query({ limit: 100 })
  return rows.find(row => row.account === Constants.DepositorAccount)
}

/** The depositor's `wtdwqueue` rows (a read). */
async function readWithdrawQueueRows(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioOpregWithdrawRequestType[]> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.opreg)
    .tables.wtdwqueue.query({ limit: 100 })
  return rows.filter(row => row.account === Constants.DepositorAccount)
}

/**
 * Node Operator Collateral Deposit — the full collateral lifecycle for a
 * NON-bootstrapped batch operator, driven end-to-end through OPP:
 *
 * 1. **ProvisionDepositor** — the ONE provisioning mechanism creates `depositor`
 *    (unique WIRE key, ETH + SOL identities, authex links, `regoperator`).
 * 2. **DepositorDaemon** — its batch-operator daemon (required once ACTIVE: the
 *    schedule prefers non-bootstrapped operators, and its group must relay).
 * 3. **DepositEthereum** — bond on the ETH outpost → depot credits the balance row.
 * 4. **DepositSolana** — bond on the SOL outpost → all-chain rule met → ACTIVE.
 * 5. **WithdrawRequest** — release half the ETH bond → depot queues it.
 * 6. **WaitAndFlush** — the wait window elapses; `flushwtdw` drains the queue.
 * 7. **ProcessRemit** — WITHDRAW_REMIT lands on the ETH outpost; escrow decrements.
 */
export class CollateralLifecycleScenario extends FlowScenario {
  readonly name = "flow-operator-collateral-deposit"
  readonly description =
    "Operator bonds ETH + SOL collateral, withdraws half the ETH bond, the depot remits the release"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    // All-chain collateral invariant: ACTIVE requires the minimum on EVERY
    // registered outpost chain, so the flow's ACTIVE assertion is meaningful.
    requiredBatchOperatorCollateral: [
      {
        chainCode: Constants.EthereumChainCode,
        tokenCode: Constants.EthereumTokenCode,
        minimumBond: Number(Constants.BondAmount)
      },
      {
        chainCode: Constants.SolanaChainCode,
        tokenCode: Constants.SolanaTokenCode,
        minimumBond: Number(Constants.BondAmount)
      }
    ]
  }

  plan(cluster: ClusterBuild): void {
    const stepOptions = {
        timeoutMs: Constants.relayDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      remitStepOptions = {
        timeoutMs: Constants.remitDeadlineMs() + Constants.PollDeadlineBufferMs
      }

    // ── 1. Provision the non-bootstrapped depositor (the ONE mechanism) ──
    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      cluster,
      "ProvisionDepositor",
      "Provision the non-bootstrapped depositor batch operator",
      {},
      [
        {
          account: Constants.DepositorAccount,
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
        `start ${Constants.DepositorAccount}'s batch-operator daemon`,
        {},
        Constants.DepositorAccount
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
        `deposit ${Constants.BondAmount} wei ETH collateral`,
        { timeoutMs: 60_000 },
        Constants.DepositorAccount,
        OperatorType.BATCH,
        BigInt(Constants.EthereumTokenCode),
        Constants.BondAmount
      ),
      verifyStep(
        Actor.Sysio,
        "depot-credits-ethereum",
        "operator's ETH balance row appears on sysio.opreg",
        async ctx => {
          await pollUntil(
            "operator's ETH balance row on sysio.opreg",
            async () => {
              const operator = await readDepositorRow(ctx)
              return (operator?.balances ?? []).some(
                balance =>
                  slugValue(balance.chain_code) ===
                    Constants.EthereumChainCode &&
                  Number(balance.balance) >= Number(Constants.BondAmount)
              )
            },
            Constants.relayDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        stepOptions
      )
    )

    // ── 4. SOL bond → all-chain rule met → ACTIVE ──
    ClusterBuildPhase.create(
      cluster,
      "DepositSolana",
      "Bond SOL collateral; operator flips ACTIVE"
    ).push(
      SolanaCollateralTool.planDeposit(
        Actor.User,
        "deposit-solana",
        `deposit ${Constants.BondAmount} lamports SOL collateral`,
        { timeoutMs: 60_000 },
        Constants.DepositorAccount,
        OperatorType.BATCH,
        BigInt(Constants.SolanaTokenCode),
        Constants.BondAmount
      ),
      verifyStep(
        Actor.Sysio,
        "depot-status-active",
        "operator status flips OPERATOR_STATUS_ACTIVE after the SOL deposit lands",
        async ctx => {
          await pollUntil(
            "depot operator status = ACTIVE",
            async () => {
              const operator = await readDepositorRow(ctx)
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
        stepOptions
      )
    )

    // ── 5. Withdraw half the ETH bond → depot queues it ──
    ClusterBuildPhase.create(
      cluster,
      "WithdrawRequest",
      "Release half the ETH bond; depot enqueues wtdwqueue"
    ).push(
      EthereumCollateralTool.planWithdrawal(
        Actor.User,
        "withdraw-ethereum",
        `withdraw ${Constants.WithdrawAmount} wei of the ETH bond`,
        { timeoutMs: 60_000 },
        Constants.DepositorAccount,
        BigInt(Constants.EthereumTokenCode),
        Constants.WithdrawAmount
      ),
      verifyStep(
        Actor.Sysio,
        "depot-enqueues-withdraw",
        "wtdwqueue row appears with the request amount",
        async ctx => {
          await pollUntil(
            "wtdwqueue row with our request amount",
            async () => {
              const requests = await readWithdrawQueueRows(ctx)
              return requests.some(
                request =>
                  slugValue(request.chain_code) ===
                    Constants.EthereumChainCode &&
                  Number(request.amount) === Number(Constants.WithdrawAmount)
              )
            },
            Constants.relayDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        stepOptions
      )
    )

    // ── 6. Wait window elapses; flushwtdw drains the queue ──
    ClusterBuildPhase.create(
      cluster,
      "WaitAndFlush",
      "The withdraw wait window elapses; flushwtdw drains the queue"
    ).push(
      verifyStep(
        Actor.Sysio,
        "flush-drains-queue",
        "wtdwqueue row drained by flushwtdw (WITHDRAW_REMIT emitted)",
        async ctx => {
          await pollUntil(
            "wtdwqueue row drained",
            async () => (await readWithdrawQueueRows(ctx)).length === 0,
            Constants.remitDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        remitStepOptions
      )
    )

    // ── 7. WITHDRAW_REMIT lands on the ETH outpost; escrow decrements ──
    ClusterBuildPhase.create(
      cluster,
      "ProcessRemit",
      "The ETH outpost processes WITHDRAW_REMIT; escrow decrements"
    ).push(
      verifyStep(
        Actor.EthereumOutpost,
        "escrow-decrements",
        `depositedByCode(ETH) decrements to ${Constants.ExpectedRemainingBalance}`,
        async ctx => {
          await pollUntil(
            "ETH escrow decremented to the remaining bond",
            async () =>
              (await EthereumCollateralTool.readDepositedByCode(
                ctx,
                Constants.DepositorAccount,
                BigInt(Constants.EthereumTokenCode)
              )) === Constants.ExpectedRemainingBalance,
            Constants.remitDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        remitStepOptions
      )
    )
  }
}
