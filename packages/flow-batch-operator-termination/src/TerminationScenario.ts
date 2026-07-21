import Assert from "node:assert"
import { PublicKey } from "@solana/web3.js"
import type { BN } from "@coral-xyz/anchor"
import { SysioContracts } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterBuildPhase,
  EthereumCollateralTool,
  FlowScenario,
  Report,
  SolanaCollateralTool,
  SolanaOutpostBootstrapper,
  WireOperatorProvisioningTool,
  getLogger,
  matchesProtoEnum,
  outputKey,
  pollUntil,
  slugValue,
  solanaKeypair,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { TerminationScenarioConstants as Constants } from "./TerminationScenarioConstants.js"

const log = getLogger(__filename)

const { SysioContractName, SysioOpregActiontype, SysioOpregOperatorstatus } =
  SysioContracts
const { Actor } = Report

/**
 * Post-deposit snapshot of the doomed operator's ETH wallet balance (wei),
 * captured after BOTH bonds landed but BEFORE termination begins. The remit
 * assertion compares against this to enforce the exact "remit credits the bond
 * amount" invariant — the operator signs zero transactions between deposit and
 * remit (the cranker pays gas on its own wallet), so the post-remit balance
 * MUST equal `baseline + EthereumBondAmount` to the wei.
 */
const PostDepositEthereumWeiKey = outputKey<bigint>(
  "TerminationScenario.postDepositEthereumWei",
  `${Constants.DoomedOperatorLabel}'s ETH wallet balance (wei) after both bonds landed`
)

/** The SOL counterpart of {@link PostDepositEthereumWeiKey} (lamports). */
const PostDepositSolanaLamportsKey = outputKey<number>(
  "TerminationScenario.postDepositSolanaLamports",
  `${Constants.DoomedOperatorLabel}'s SOL wallet balance (lamports) after both bonds landed`
)

/** The doomed operator's node-owner-generated chain account, resolved from the key store. */
function doomedOperatorAccount(ctx: ClusterBuildContext): string {
  return ctx.keyStore.assertOperator(Constants.DoomedOperatorLabel).account
}

/** The doomed operator's row on `sysio.opreg::operators` (a read). */
async function readDoomedOperatorRow(
  ctx: ClusterBuildContext
): Promise<SysioContracts.SysioOpregOperatorEntryType> {
  const account = doomedOperatorAccount(ctx),
    { rows } = await ctx.wire
      .getSysioContract(SysioContractName.opreg)
      .tables.operators.query({ limit: Constants.OperatorsQueryLimit })
  return rows.find(row => row.account === account)
}

/** The sliding-window schedule groups from the `sysio.epoch::epochstate` singleton (a read). */
async function readScheduleGroups(
  ctx: ClusterBuildContext
): Promise<string[][]> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.epoch)
    .tables.epochstate.query({ limit: Constants.EpochStateQueryLimit })
  return rows[0]?.batch_op_groups ?? []
}

/**
 * Chain codes (slug numerics) of the doomed operator's success-true
 * WITHDRAW_REMIT audit entries (a read). `sysio.opreg::flushwtdw` queues the
 * remit on msgch (transient — drained when `buildenv` packs the outbound
 * envelope) AND appends a PERMANENT entry to the operator's `recent_actions`
 * ring buffer; the ring buffer is therefore the source of truth here.
 */
async function readWithdrawRemitChainCodes(
  ctx: ClusterBuildContext
): Promise<Set<number>> {
  const operator = await readDoomedOperatorRow(ctx)
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
  return new Set(remits.map(entry => slugValue(entry.action.chain_code)))
}

/** One SOL outpost `collateral_by_code` ledger entry as Anchor decodes it (camelCased IDL fields, u64s as BN). */
interface SolanaCollateralLedgerEntry {
  depositor: PublicKey
  tokenCode: BN
  amount: BN
}

/** The slice of the SOL outpost's `OperatorRegistry` PDA account this flow reads. */
interface SolanaOperatorRegistryAccount {
  collateralByCode: SolanaCollateralLedgerEntry[]
}

/** Anchor account-client surface for a runtime-loaded IDL (untyped `Program<Idl>` namespace). */
interface SolanaAccountClient {
  fetch(address: PublicKey): Promise<unknown>
}

/** The SOL outpost's on-chain collateral ledger from the `OperatorRegistry` PDA (a read). */
async function readSolanaCollateralLedger(
  ctx: ClusterBuildContext
): Promise<SolanaCollateralLedgerEntry[]> {
  const operator = ctx.keyStore.assertOperator(Constants.DoomedOperatorLabel)
  const program = SolanaCollateralTool.loadOppOutpostProgram(
    ctx,
    solanaKeypair(operator.solana)
  )
  const [registryAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from(SolanaOutpostBootstrapper.PdaSeed.OperatorRegistry)],
    program.programId
  )
  // Anchor types `Program<Idl>.account` per-IDL; for a runtime-loaded IDL the
  // account clients are reached by name — one assertion to the string-keyed view.
  const accounts: Record<string, SolanaAccountClient> = program.account
  const registryAccount = (await accounts[
    Constants.SolanaOperatorRegistryAccountName
  ].fetch(registryAddress)) as SolanaOperatorRegistryAccount
  return registryAccount.collateralByCode ?? []
}

/**
 * Batch Operator Termination via Delivery Underperformance — verifies the full
 * protocol promise that a non-bootstrapped operator becomes ACTIVE only after
 * posting required collateral on EVERY active outpost, and that on termination
 * the bonded collateral is remitted back from every outpost's vault:
 *
 * 1. **ChainHealth** — WIRE produces blocks; anvil's `OperatorRegistry` has
 *    code; the SOL test-validator answers.
 * 2. **ProvisionOperator** — the ONE provisioning mechanism creates the doomed
 *    operator (unique WIRE key, ETH + SOL identities, authex links,
 *    `regoperator(is_bootstrapped=false)`). Bootstrapped operators bypass the
 *    termination machinery, so non-bootstrapped is the point.
 * 3. **VerifyRegistration** — the row exists, non-bootstrapped, status UNKNOWN
 *    (no deposits yet — every `available(...)` in `meets_role_min` is 0).
 * 4. **DepositEthereum** — bond on the ETH outpost → depot credits the ETH
 *    balance row; status STAYS UNKNOWN while the SOL requirement is unmet.
 * 5. **DepositSolana** — bond on the SOL outpost → all-chain rule met → ACTIVE;
 *    snapshot both wallet balances as remit-exactness baselines.
 * 6. **AccumulateMisses** — `advance`'s new-tail computation folds the operator
 *    into `epochstate.batch_op_groups`. Its daemon is DELIBERATELY never
 *    started, so every scheduled epoch records `recorddel(delivered=false)`.
 * 7. **Terminate** — after ≥ `terminateMaxConsecutiveMisses` consecutive missed
 *    epochs, `termcheck` flips TERMINATED with `terminated_at > 0` and a
 *    populated `status_reason`.
 * 8. **RemitBonds** — the depot auto-remits the full bond on termination:
 *    success-true WITHDRAW_REMIT audit entries land for BOTH chains, each
 *    outpost's escrow ledger returns to 0, and each wallet is credited the
 *    exact bond amount (wei/lamport-exact — any drift means the outpost decoded
 *    a different amount than the depot encoded).
 */
export class TerminationScenario extends FlowScenario {
  readonly name = "flow-batch-operator-termination"
  readonly description =
    "Non-bootstrapped batch operator bonds ETH + SOL, misses its scheduled deliveries, is terminated, and both bonds are remitted back"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    batchOperatorCount: Constants.BatchOperatorCount,
    terminateMaxConsecutiveMisses: Constants.TerminateMaxConsecutiveMisses,
    // Depot must enforce "ACTIVE requires the minimum on EVERY registered
    // outpost chain" — otherwise the operator flips ACTIVE on an empty
    // requirement check and the flow greens on incomplete config (the false
    // positive that motivated the non-bootstrapped rewrite).
    requiredBatchOperatorCollateral: [
      {
        chainCode: Constants.EthereumChainCode,
        tokenCode: Constants.EthereumTokenCode,
        minimumBond: Constants.RequiredEthereumMinimumBond
      },
      {
        chainCode: Constants.SolanaChainCode,
        tokenCode: Constants.SolanaTokenCode,
        minimumBond: Constants.RequiredSolanaMinimumBond
      }
    ]
  }

  plan(cluster: ClusterBuild): void {
    const quickStepOptions = { timeoutMs: Constants.QuickVerifyTimeoutMs },
      depositStepOptions = { timeoutMs: Constants.DepositStepTimeoutMs },
      ethereumDepositStepOptions = {
        timeoutMs:
          Constants.ethereumDepositDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      solanaActivationStepOptions = {
        timeoutMs:
          Constants.solanaActivationDeadlineMs() +
          Constants.PollDeadlineBufferMs
      },
      scheduleWindowStepOptions = {
        timeoutMs:
          Constants.scheduleWindowDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      terminationStepOptions = {
        timeoutMs:
          Constants.terminationDeadlineMs() + Constants.PollDeadlineBufferMs
      },
      remitStepOptions = {
        timeoutMs: Constants.remitDeadlineMs() + Constants.PollDeadlineBufferMs
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
        "anvil answers and OperatorRegistry has deployed code",
        async ctx => {
          const registry = EthereumCollateralTool.loadOperatorRegistry(
            ctx,
            ctx.ethereum.wallet.signer
          )
          const code = await ctx.ethereum.provider.getCode(
            await registry.getAddress()
          )
          Assert.ok(
            code.length > Constants.MinimumContractCodeLength,
            `OperatorRegistry has no code on anvil (getCode returned ${code.length} chars)`
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
          isBootstrapped: false,
          airdropSolanaLamports: Constants.DoomedOperatorAirdropLamports
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
          const operator = await readDoomedOperatorRow(ctx)
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

    // ── 4. ETH bond → depot balance row; status stays UNKNOWN ──
    ClusterBuildPhase.create(
      cluster,
      "DepositEthereum",
      "Bond ETH collateral; depot credits the balance row; status stays UNKNOWN"
    ).push(
      EthereumCollateralTool.planDeposit(
        Actor.User,
        "deposit-ethereum",
        `deposit ${Constants.EthereumBondAmount} wei ETH collateral`,
        depositStepOptions,
        Constants.DoomedOperatorLabel,
        OperatorType.BATCH,
        BigInt(Constants.EthereumTokenCode),
        Constants.EthereumBondAmount
      ),
      verifyStep(
        Actor.Sysio,
        "depot-credits-ethereum",
        "operator's ETH balance row reaches the required minimum on sysio.opreg",
        async ctx => {
          await pollUntil(
            "depot ETH balance row ≥ required minimum",
            async () => {
              const operator = await readDoomedOperatorRow(ctx)
              return (operator?.balances ?? []).some(
                balance =>
                  slugValue(balance.chain_code) ===
                    Constants.EthereumChainCode &&
                  Number(balance.balance) >=
                    Constants.RequiredEthereumMinimumBond
              )
            },
            Constants.ethereumDepositDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        ethereumDepositStepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "ethereum-only-stays-unknown",
        "status stays UNKNOWN while the SOL requirement is unmet",
        async ctx => {
          const operator = await readDoomedOperatorRow(ctx)
          Assert.ok(
            operator != null &&
              matchesProtoEnum(
                operator.status,
                SysioOpregOperatorstatus,
                SysioOpregOperatorstatus.OPERATOR_STATUS_UNKNOWN
              ),
            `${Constants.DoomedOperatorLabel} flipped past UNKNOWN on the ETH bond alone (got ${operator?.status})`
          )
        },
        quickStepOptions
      )
    )

    // ── 5. SOL bond → all-chain rule met → ACTIVE; snapshot remit baselines ──
    ClusterBuildPhase.create(
      cluster,
      "DepositSolana",
      "Bond SOL collateral; operator flips ACTIVE; snapshot wallet baselines"
    ).push(
      SolanaCollateralTool.planDeposit(
        Actor.User,
        "deposit-solana",
        `deposit ${Constants.SolanaBondAmount} lamports SOL collateral`,
        depositStepOptions,
        Constants.DoomedOperatorLabel,
        OperatorType.BATCH,
        BigInt(Constants.SolanaTokenCode),
        Constants.SolanaBondAmount
      ),
      verifyStep(
        Actor.Sysio,
        "depot-status-active",
        "both balance rows satisfied → status flips OPERATOR_STATUS_ACTIVE",
        async ctx => {
          await pollUntil(
            "depot operator status = ACTIVE after the SOL deposit lands",
            async () => {
              const operator = await readDoomedOperatorRow(ctx)
              return (
                operator != null &&
                matchesProtoEnum(
                  operator.status,
                  SysioOpregOperatorstatus,
                  SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
                )
              )
            },
            Constants.solanaActivationDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        solanaActivationStepOptions
      ),
      verifyStep(
        Actor.User,
        "snapshot-post-deposit-balances",
        "capture the operator's post-deposit ETH + SOL wallet balances (remit-exactness baselines)",
        async ctx => {
          const operator = ctx.keyStore.assertOperator(
            Constants.DoomedOperatorLabel
          )
          const wei = await ctx.ethereum.getBalance(operator.ethereum.address)
          const lamports = await ctx.solana.getLamports(
            solanaKeypair(operator.solana).publicKey
          )
          ctx.outputs
            .set(PostDepositEthereumWeiKey, wei)
            .set(PostDepositSolanaLamportsKey, lamports)
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
                  members =>
                    Array.isArray(members) && members.includes(account)
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
              const operator = await readDoomedOperatorRow(ctx)
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
          const operator = await readDoomedOperatorRow(ctx)
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

    // ── 8. Depot auto-remits the full bond on termination — both outposts ──
    ClusterBuildPhase.create(
      cluster,
      "RemitBonds",
      "The depot remits both bonds; each outpost zeroes escrow and credits the wallet"
    ).push(
      verifyStep(
        Actor.Sysio,
        "depot-emits-withdraw-remits",
        "recent_actions carries success-true WITHDRAW_REMIT audit entries for BOTH chains",
        async ctx => {
          await pollUntil(
            "success-true WITHDRAW_REMIT for both ETH and SOL in recent_actions",
            async () => {
              const chainCodes = await readWithdrawRemitChainCodes(ctx)
              return (
                chainCodes.has(Constants.EthereumChainCode) &&
                chainCodes.has(Constants.SolanaChainCode)
              )
            },
            Constants.remitDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        remitStepOptions
      ),
      verifyStep(
        Actor.EthereumOutpost,
        "ethereum-escrow-zeroed",
        "depositedByCode(operator, ETH) returns to 0 after the inbound WITHDRAW_REMIT",
        async ctx => {
          await pollUntil(
            "ETH OperatorRegistry escrow returns to 0",
            async () =>
              (await EthereumCollateralTool.readDepositedByCode(
                ctx,
                Constants.DoomedOperatorLabel,
                BigInt(Constants.EthereumTokenCode)
              )) === 0n,
            Constants.remitDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        remitStepOptions
      ),
      verifyStep(
        Actor.EthereumOutpost,
        "ethereum-wallet-credited-exact",
        `operator ETH wallet balance rises by exactly ${Constants.EthereumBondAmount} wei`,
        async ctx => {
          // The operator signs zero transactions between the snapshot and the
          // remit, so the delta is purely `_transferOut(amount)` from
          // `_handleWithdrawRemit` — any drift means the outpost applied a
          // different amount than the depot encoded into the attestation.
          const baseline = ctx.outputs.assert(PostDepositEthereumWeiKey)
          const operator = ctx.keyStore.assertOperator(
            Constants.DoomedOperatorLabel
          )
          await pollUntil(
            `operator ETH wallet credited exactly ${Constants.EthereumBondAmount} wei`,
            async () =>
              (await ctx.ethereum.getBalance(operator.ethereum.address)) -
                baseline ===
              Constants.EthereumBondAmount,
            Constants.remitDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        remitStepOptions
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "solana-wallet-credited-exact",
        `operator SOL wallet balance rises by exactly ${Constants.SolanaBondAmount} lamports`,
        async ctx => {
          // The cranker pays the `epoch_in` fees on its own keypair and the
          // on-chain handler signed-CPI transfers vault → operator, so the
          // lamport delta is purely the bond amount.
          const baseline = ctx.outputs.assert(PostDepositSolanaLamportsKey)
          const operator = ctx.keyStore.assertOperator(
            Constants.DoomedOperatorLabel
          )
          const operatorPublicKey = solanaKeypair(operator.solana).publicKey
          await pollUntil(
            `operator SOL wallet credited exactly ${Constants.SolanaBondAmount} lamports`,
            async () =>
              BigInt(
                (await ctx.solana.getLamports(operatorPublicKey)) - baseline
              ) === Constants.SolanaBondAmount,
            Constants.remitDeadlineMs(),
            Constants.PollIntervalMs
          )
        },
        remitStepOptions
      ),
      verifyStep(
        Actor.SolanaOutpost,
        "solana-ledger-zeroed",
        "the outpost's collateral_by_code ledger row for the operator is pruned or 0",
        async ctx => {
          const operator = ctx.keyStore.assertOperator(
            Constants.DoomedOperatorLabel
          )
          const operatorPublicKey = solanaKeypair(operator.solana).publicKey
          const solanaTokenCode = BigInt(Constants.SolanaTokenCode)
          const ledger = await readSolanaCollateralLedger(ctx)
          const row = ledger.find(
            entry =>
              entry.depositor.equals(operatorPublicKey) &&
              BigInt(entry.tokenCode.toString()) === solanaTokenCode
          )
          // The row may be retained at 0 or pruned — either is a valid remit
          // outcome; only a non-zero residue is a failure.
          Assert.ok(
            row == null || BigInt(row.amount.toString()) === 0n,
            `SOL collateral ledger row not zeroed (amount=${row?.amount?.toString()})`
          )
        },
        quickStepOptions
      )
    )
  }
}
