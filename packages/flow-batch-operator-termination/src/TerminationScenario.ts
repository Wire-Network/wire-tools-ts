import Assert from "node:assert"
import { PublicKey } from "@solana/web3.js"
import type { BN } from "@coral-xyz/anchor"
import { SysioContracts } from "@wireio/sdk-core"
import { OperatorType } from "@wireio/opp-typescript-models"
import {
  ClusterBuildPhase,
  ClusterBuildStep,
  ClusterConfigProvider,
  EthereumCollateralTool,
  FlowScenario,
  NodeConfig,
  NodeRole,
  OperatorDaemonTool,
  Report,
  SolanaCollateralTool,
  SolanaOutpostBootstrapper,
  SolanaOutpostProgramTool,
  Steps,
  WireOperatorProvisioningTool,
  contractView,
  getLogger,
  matchesProtoEnum,
  outputKey,
  pollUntil,
  slugValue,
  solanaKeypair,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions,
  type StepInput
} from "@wireio/cluster-tool"
import { TerminationScenarioConstants as Constants } from "./TerminationScenarioConstants.js"
import { assertReplacementQuorumPeer } from "./ReplacementQuorum.js"

const log = getLogger(__filename)

const {
  SysioContractName,
  SysioOpregActiontype,
  SysioOpregOperatortype,
  SysioOpregOperatorstatus
} = SysioContracts
const { Actor } = Report

/** Minimal Ethereum inbound surface needed to prove sequential acceptance. */
interface EthereumInboundView {
  activeGroupIndex(): Promise<bigint>
  batchOpGroups(groupIndex: number, memberIndex: number): Promise<string>
  epochDeliveries(epochIndex: number, operator: string): Promise<string>
  nextEpochIndex(): Promise<bigint>
}

/** Anchor-decoded subset of the Solana outpost configuration account. */
interface SolanaOutpostConfigAccount {
  nextEpochIndex: BN
}

/** State captured after the first schedule candidate is withheld. */
interface WithheldScheduleCheckpoint {
  epochIndex: number
  activeGroup: string[]
  ethereumNextEpoch: number
  solanaNextEpoch: number
}

/** State captured after a replacement makes the held window publishable. */
interface RepairedScheduleCheckpoint extends WithheldScheduleCheckpoint {
  nextGroup: string[]
}

const WithheldScheduleCheckpointKey = outputKey<WithheldScheduleCheckpoint>(
  "TerminationScenario.withheldScheduleCheckpoint",
  "depot duty and outpost epoch cursors after the first withheld schedule window"
)
const RepairedScheduleCheckpointKey = outputKey<RepairedScheduleCheckpoint>(
  "TerminationScenario.repairedScheduleCheckpoint",
  "held duty, next group, and outpost cursors after the repaired window is published"
)
const HeldSlashAccountKey = outputKey<string>(
  "TerminationScenario.heldSlashAccount",
  "operator removed from the announced group while schedule duty is held"
)
const HeldSlashEpochKey = outputKey<number>(
  "TerminationScenario.heldSlashEpoch",
  "depot epoch in which a member of the held group was slashed"
)
const RecoverySlashAccountKey = outputKey<string>(
  "TerminationScenario.recoverySlashAccount",
  "active current-group operator selected for the first recovery slash"
)

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

/**
 * Rent held by the operator's `CollateralPosition` PDA while the bond is open.
 *
 * SOL-379 made collateral a per-`(operator, token_code)` PDA that the DEPOSITOR
 * rent-funds and that auto-closes once its balance reaches zero — refunding
 * that rent to the operator. So a WITHDRAW_REMIT credits the wallet with the
 * bond AND this rent, and the remit-exactness check has to know both halves.
 * Captured from the live account rather than hardcoded, so it tracks
 * `CollateralPosition::SIZE` instead of silently drifting when the struct
 * changes. Must be read BEFORE the remit — the account is gone afterwards.
 */
const PostDepositSolanaPositionRentKey = outputKey<number>(
  "TerminationScenario.postDepositSolanaPositionRent",
  `${Constants.DoomedOperatorLabel}'s SOL CollateralPosition rent (lamports), refunded when the remit empties it`
)

/** The doomed operator's node-owner-generated WIRE account, resolved from the key store by its label. */
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
  activeGroupIndex: number
  collateralByCode: SolanaCollateralLedgerEntry[]
  groupCount: number
  groups: SolanaOperatorGroup[]
}

/** One fixed-capacity group in the zero-copy Solana operator registry. */
interface SolanaOperatorGroup {
  memberCount: number
  members: PublicKey[]
}

/** Signer records retained for one accepted Solana inbound epoch. */
interface SolanaOperatorDelivery {
  operator: PublicKey
}

/** Signer records retained for one accepted Solana inbound epoch. */
interface SolanaEpochDeliveriesAccount {
  deliveries: SolanaOperatorDelivery[]
}

/** Anchor account-client surface for a runtime-loaded IDL (untyped `Program<Idl>` namespace). */
interface SolanaAccountClient {
  fetch(address: PublicKey): Promise<unknown>
  fetchNullable(address: PublicKey): Promise<unknown | null>
}

/** Bound Solana OPP account readers and their program addresses. */
interface SolanaOppAccounts {
  accounts: Record<string, SolanaAccountClient>
  configAddress: PublicKey
  programId: PublicKey
}

/** Cross-chain signing identities for one replacement operator. */
interface ReplacementAddresses {
  ethereum: string
  solana: PublicKey
}

/** Compare ordered operator groups without depending on array identity. */
function sameGroup(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

/** Require the full disjoint schedule used by the recovery regression. */
function assertCompleteSchedule(groups: readonly string[][]): void {
  Assert.equal(
    groups.length,
    Constants.BatchOperatorGroups,
    "schedule group count changed"
  )
  const members = new Set<string>()
  for (const group of groups) {
    Assert.equal(
      group.length,
      Constants.OperatorsPerEpoch,
      "schedule contains a short group"
    )
    for (const member of group) {
      Assert.ok(
        !members.has(member),
        `${member} is seated in more than one group`
      )
      members.add(member)
    }
  }
  Assert.equal(
    members.size,
    Constants.BatchOperatorCount,
    "schedule window is not full"
  )
}

/** Read the Ethereum outpost's next sequential inbound epoch. */
async function readEthereumNextEpoch(
  ctx: ClusterBuildContext
): Promise<number> {
  return Number(await loadEthereumInbound(ctx).nextEpochIndex())
}

/** Bind the deployed Ethereum inbound contract to its read-only flow surface. */
function loadEthereumInbound(ctx: ClusterBuildContext): EthereumInboundView {
  const deploymentsPath = ClusterConfigProvider.ethereumDeploymentsPath(
    ctx.config
  )
  const addresses = EthereumCollateralTool.loadOutpostAddresses(deploymentsPath)
  return contractView<EthereumInboundView>(
    addresses.OPPInbound,
    EthereumCollateralTool.loadOutpostAbi(
      ctx.config.ethereumPath,
      "OPPInbound"
    ),
    ctx.ethereum.wallet.signer
  )
}

/** Read the Solana outpost's next sequential inbound epoch. */
async function readSolanaNextEpoch(ctx: ClusterBuildContext): Promise<number> {
  const { accounts, configAddress } = loadSolanaOppAccounts(ctx)
  const config = (await accounts[
    Constants.SolanaOutpostConfigAccountName
  ].fetch(configAddress)) as SolanaOutpostConfigAccount
  return Number(config.nextEpochIndex.toString())
}

/** Load the Solana OPP program and the account namespace used by flow reads. */
function loadSolanaOppAccounts(ctx: ClusterBuildContext): SolanaOppAccounts {
  const reader = ctx.keyStore.assertOperator(
    Constants.RecoverySolanaReaderLabel
  )
  const program = SolanaCollateralTool.loadOppOutpostProgram(
    ctx,
    solanaKeypair(reader.solana)
  )
  const configAddress = SolanaOutpostProgramTool.derivePda(
    program.programId,
    Buffer.from(SolanaOutpostBootstrapper.PdaSeed.OutpostConfig)
  )
  const accounts: Record<string, SolanaAccountClient> = program.account
  return { accounts, configAddress, programId: program.programId }
}

/** Cross-chain signing addresses for one WIRE operator account. */
function replacementAddresses(
  ctx: ClusterBuildContext,
  account: string
): ReplacementAddresses {
  const operator = ctx.keyStore.operators.find(
    entry => entry.account === account
  )
  Assert.ok(operator != null, `${account} is absent from the cluster key store`)
  Assert.ok(operator.ethereum != null, `${account} has no Ethereum identity`)
  Assert.ok(operator.solana != null, `${account} has no Solana identity`)
  return {
    ethereum: operator.ethereum.address,
    solana: solanaKeypair(operator.solana).publicKey
  }
}

/**
 * Prove one replacement signed accepted deliveries for the same duty epoch on
 * both outposts. Each contract records a signer only after its active-group
 * admission check, so this is also direct evidence that the replacement's
 * propagated address was seated rather than merely present in the depot group.
 */
async function replacementDeliveredOnBothOutposts(
  ctx: ClusterBuildContext,
  account: string,
  epochIndex: number
): Promise<boolean> {
  const addresses = replacementAddresses(ctx, account)
  const ethereumDigest = await loadEthereumInbound(ctx).epochDeliveries(
    epochIndex,
    addresses.ethereum
  )
  if (/^0x0{64}$/i.test(ethereumDigest)) return false

  const { accounts, programId } = loadSolanaOppAccounts(ctx)
  const epochBytes = Buffer.alloc(4)
  epochBytes.writeUInt32LE(epochIndex)
  const deliveriesAddress = SolanaOutpostProgramTool.derivePda(
    programId,
    Buffer.from("epoch_deliveries"),
    epochBytes
  )
  const deliveries = (await accounts.epochDeliveries.fetchNullable(
    deliveriesAddress
  )) as SolanaEpochDeliveriesAccount | null
  return (
    deliveries != null &&
    deliveries.deliveries.some(entry => entry.operator.equals(addresses.solana))
  )
}

interface StopReplacementPeerInput extends StepInput {
  readonly kind: "TerminationScenario.StopReplacementPeerInput"
  readonly label: string
}

/** Stop one original signer so this replacement is necessary for quorum. */
async function runStopReplacementPeer(
  ctx: ClusterBuildContext,
  input: StopReplacementPeerInput,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const state = await Steps.contracts.sysio.epoch.readEpochState(ctx)
  const replacements = Constants.RecoveryOperatorLabels.map(
    label => ctx.keyStore.assertOperator(label).account
  )
  const replacement = ctx.keyStore.assertOperator(input.label).account
  const account = assertReplacementQuorumPeer(
    state.batch_op_groups,
    replacements,
    replacement
  )
  const operator = ctx.keyStore.operators.find(entry => entry.account === account)
  Assert.ok(operator != null, `${account} has no operator identity`)
  const node = NodeConfig.plan(ctx.config).find(
    entry =>
      entry.role === NodeRole.batch_operator &&
      entry.batchOperatorLabel === operator.label
  )
  Assert.ok(node != null, `${account} has no planned batch-operator daemon`)
  const daemon = ctx.processManager.get(node.name)
  Assert.ok(daemon != null, `${node.name} is not registered`)
  // Replacements in the same group select the same peer. stop() is idempotent.
  await daemon.stop(signal)
  log.info(
    `stopped ${account}'s daemon; ${replacement} is required for quorum`
  )
}

/** Read whether an operator is SLASHED in the depot registry. */
async function operatorIsSlashed(
  ctx: ClusterBuildContext,
  account: string
): Promise<boolean> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.opreg)
    .tables.operators.query({ limit: Constants.OperatorsQueryLimit })
  const target = rows.find(row => row.account === account)
  return (
    target != null &&
    matchesProtoEnum(
      target.status,
      SysioOpregOperatorstatus,
      SysioOpregOperatorstatus.OPERATOR_STATUS_SLASHED
    )
  )
}

/** Read the ACTIVE batch-operator account names from the live registry. */
async function readActiveBatchOperatorAccounts(
  ctx: ClusterBuildContext
): Promise<Set<string>> {
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.opreg)
    .tables.operators.query({ limit: Constants.OperatorsQueryLimit })
  return new Set(
    rows
      .filter(
        row =>
          matchesProtoEnum(
            row.type,
            SysioOpregOperatortype,
            SysioOpregOperatortype.OPERATOR_TYPE_BATCH
          ) &&
          matchesProtoEnum(
            row.status,
            SysioOpregOperatorstatus,
            SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
          )
      )
      .map(row => row.account)
  )
}

/** Select and slash an active member of the live current group without crossing an epoch boundary. */
async function runSlashRecoveryTarget(
  ctx: ClusterBuildContext,
  _input: null,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const before = await Steps.contracts.sysio.epoch.readEpochState(ctx)
  assertCompleteSchedule(before.batch_op_groups)
  assertCompleteSchedule(before.next_batch_op_groups)
  const current = before.batch_op_groups[before.current_batch_op_group] ?? []
  const activeAccounts = await readActiveBatchOperatorAccounts(ctx)
  Assert.equal(
    activeAccounts.size,
    Constants.BatchOperatorCount,
    "recovery slash did not start at the exact active roster floor"
  )
  Assert.ok(
    current.every(account => activeAccounts.has(account)),
    "current duty contains an inactive historical placeholder"
  )
  const readerAccount = ctx.keyStore.assertOperator(
    Constants.RecoverySolanaReaderLabel
  ).account
  const account = current.find(member => member !== readerAccount)
  Assert.ok(
    account != null,
    "current duty has no eligible recovery slash target"
  )
  await Steps.contracts.sysio.opreg.runSlash(
    ctx,
    {
      kind: "OpregContractSteps.SlashInput",
      data: {
        account,
        reason: "WIRE-385 schedule recovery regression"
      }
    },
    signal
  )
  const after = await Steps.contracts.sysio.epoch.readEpochState(ctx)
  const afterCurrent = after.batch_op_groups[after.current_batch_op_group] ?? []
  Assert.equal(
    Number(after.current_epoch_index),
    Number(before.current_epoch_index),
    "epoch advanced across the recovery slash"
  )
  Assert.ok(
    sameGroup(afterCurrent, current),
    "current duty changed across the recovery slash"
  )
  ctx.outputs.set(RecoverySlashAccountKey, account)
}

/** Remove one eligible member from the group whose duty is currently held. */
async function runSlashHeldGroupMember(
  ctx: ClusterBuildContext,
  _input: null,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted()
  const checkpoint = ctx.outputs.assert(WithheldScheduleCheckpointKey)
  const { rows } = await ctx.wire
    .getSysioContract(SysioContractName.opreg)
    .tables.operators.query({ limit: Constants.OperatorsQueryLimit })
  const firstSlashAccount = ctx.outputs.assert(RecoverySlashAccountKey)
  const readerAccount = ctx.keyStore.assertOperator(
    Constants.RecoverySolanaReaderLabel
  ).account
  const candidate = checkpoint.activeGroup.find(account => {
    if (account === firstSlashAccount || account === readerAccount) {
      return false
    }
    const row = rows.find(operator => operator.account === account)
    return (
      row != null &&
      matchesProtoEnum(
        row.type,
        SysioOpregOperatortype,
        SysioOpregOperatortype.OPERATOR_TYPE_BATCH
      ) &&
      matchesProtoEnum(
        row.status,
        SysioOpregOperatorstatus,
        SysioOpregOperatorstatus.OPERATOR_STATUS_ACTIVE
      )
    )
  })
  Assert.ok(candidate != null, "held group has no eligible slash candidate")
  const state = await Steps.contracts.sysio.epoch.readEpochState(ctx)
  await Steps.contracts.sysio.opreg.runSlash(
    ctx,
    {
      kind: "OpregContractSteps.SlashInput",
      data: {
        account: candidate,
        reason: "WIRE-385 held-duty recovery regression"
      }
    },
    signal
  )
  ctx.outputs.set(HeldSlashAccountKey, candidate)
  ctx.outputs.set(HeldSlashEpochKey, Number(state.current_epoch_index))
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
 * 9. **Schedule recovery** — remove an announced operator at the exact roster
 *    floor, prove the depot freezes that duty while both outposts keep accepting
 *    sequential epochs, remove another member while frozen, add two replacements,
 *    and prove publication and rotation resume through replacement-backed duty.
 */
export class TerminationScenario extends FlowScenario {
  readonly name = "flow-batch-operator-termination"
  readonly description =
    "Terminate and remit a non-bootstrapped operator, then freeze, repair, and resume a depleted batch schedule across Ethereum and Solana"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    batchOperatorCount: Constants.BatchOperatorCount,
    operatorsPerEpoch: Constants.OperatorsPerEpoch,
    batchOpGroups: Constants.BatchOperatorGroups,
    adHocCount: Constants.RecoveryAdHocDaemonCount,
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
        "capture the operator's post-deposit ETH + SOL wallet balances and SOL position rent (remit-exactness baselines)",
        async ctx => {
          const operator = ctx.keyStore.assertOperator(
            Constants.DoomedOperatorLabel
          )
          const operatorKeypair = solanaKeypair(operator.solana)
          const operatorPublicKey = operatorKeypair.publicKey
          const wei = await ctx.ethereum.getBalance(operator.ethereum.address)
          const lamports = await ctx.solana.getLamports(operatorPublicKey)
          // Read the position's rent while the account still exists — the
          // remit empties it and the program closes it, refunding this to the
          // operator's wallet (see PostDepositSolanaPositionRentKey).
          const programId = SolanaOutpostProgramTool.assertProgramId(
              ctx.config.solanaPath
            ),
            positionPda = SolanaCollateralTool.collateralPositionPda(
              programId,
              operatorPublicKey,
              BigInt(Constants.SolanaTokenCode)
            ),
            positionRent = await ctx.solana.getLamports(positionPda)
          Assert.ok(
            positionRent > 0,
            `CollateralPosition PDA ${positionPda.toBase58()} is missing ` +
              `(rent=0) for program ${programId.toBase58()}`
          )
          ctx.outputs
            .set(PostDepositEthereumWeiKey, wei)
            .set(PostDepositSolanaLamportsKey, lamports)
            .set(PostDepositSolanaPositionRentKey, positionRent)
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
        `operator SOL wallet balance rises by exactly the ${Constants.SolanaBondAmount}-lamport bond plus the refunded position rent`,
        async ctx => {
          // The cranker pays the `epoch_in` fees on its own keypair and the
          // on-chain handler signed-CPI transfers vault → operator, so the
          // operator's lamport delta is the bond PLUS the rent refunded when
          // the emptied `CollateralPosition` PDA auto-closes (SOL-379 — the
          // depositor funded that rent at deposit time). Both halves are
          // exact: the rent is the account's live balance, snapshotted before
          // the remit destroys the account.
          const baseline = ctx.outputs.assert(PostDepositSolanaLamportsKey)
          const positionRent = ctx.outputs.assert(
            PostDepositSolanaPositionRentKey
          )
          const expected = Constants.SolanaBondAmount + BigInt(positionRent)
          const operator = ctx.keyStore.assertOperator(
            Constants.DoomedOperatorLabel
          )
          const operatorPublicKey = solanaKeypair(operator.solana).publicKey
          await pollUntil(
            `operator SOL wallet credited exactly ${expected} lamports (${Constants.SolanaBondAmount} bond + ${positionRent} position rent)`,
            async () =>
              BigInt(
                (await ctx.solana.getLamports(operatorPublicKey)) - baseline
              ) === expected,
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

    // ── 9. Reach the exact roster floor with a fully active group on duty ──
    ClusterBuildPhase.create(
      cluster,
      "PrepareScheduleRecovery",
      "The terminated test operator is gone and a complete window reaches active current duty"
    ).push(
      verifyStep(
        Actor.Sysio,
        "exact-minimum-window-ready",
        "three disjoint groups of three remain with a fully active current group",
        async ctx => {
          await pollUntil(
            "a complete three-by-three window has a fully active current group",
            async () => {
              const state =
                await Steps.contracts.sysio.epoch.readEpochState(ctx)
              const groups = state.batch_op_groups
              const complete =
                groups.length === Constants.BatchOperatorGroups &&
                groups.every(
                  group => group.length === Constants.OperatorsPerEpoch
                )
              if (!complete) return false
              const published = state.next_batch_op_groups
              if (
                published.length !== Constants.BatchOperatorGroups ||
                published.some(
                  group => group.length !== Constants.OperatorsPerEpoch
                )
              ) {
                return false
              }
              assertCompleteSchedule(published)
              assertCompleteSchedule(groups)
              const current = groups[state.current_batch_op_group] ?? []
              const activeAccounts = await readActiveBatchOperatorAccounts(ctx)
              if (activeAccounts.size !== Constants.BatchOperatorCount) {
                return false
              }
              const readerAccount = ctx.keyStore.assertOperator(
                Constants.RecoverySolanaReaderLabel
              ).account
              return (
                current.every(account => activeAccounts.has(account)) &&
                current.some(account => account !== readerAccount)
              )
            },
            Constants.recoveryDeadlineMs(Constants.BatchOperatorGroups + 2),
            Constants.PollIntervalMs
          )
        },
        {
          timeoutMs: Constants.recoveryDeadlineMs(
            Constants.BatchOperatorGroups + 2
          )
        }
      )
    )

    // ── 10. Remove one current member at the exact floor → withhold ──
    ClusterBuildPhase.create(
      cluster,
      "StarveScheduleWindow",
      "Slashing one seated operator makes the next tail one seat short"
    ).push(
      ClusterBuildStep.create(
        Actor.Sysio,
        "slash-current-member",
        "slash the selected active current-group member to exercise withheld-window recovery",
        {},
        null,
        runSlashRecoveryTarget
      ),
      verifyStep(
        Actor.Sysio,
        "capture-withheld-window",
        "the first advance enters announced duty and discards an incomplete candidate",
        async ctx => {
          let checkpoint: WithheldScheduleCheckpoint | null = null
          await pollUntil(
            "no next window is published after the target is slashed",
            async () => {
              const state =
                await Steps.contracts.sysio.epoch.readEpochState(ctx)
              const current =
                state.batch_op_groups[state.current_batch_op_group] ?? []
              assertCompleteSchedule(state.batch_op_groups)
              const withheld = state.next_batch_op_groups.length === 0
              const slashTarget = ctx.outputs.assert(RecoverySlashAccountKey)
              if (
                !(await operatorIsSlashed(ctx, slashTarget)) ||
                !withheld ||
                current.length === 0
              ) {
                return false
              }
              Assert.ok(
                !current.includes(slashTarget),
                "withheld duty did not enter the announced successor"
              )
              const [ethereumNextEpoch, solanaNextEpoch] = await Promise.all([
                readEthereumNextEpoch(ctx),
                readSolanaNextEpoch(ctx)
              ])
              const expectedNextEpoch = Number(state.current_epoch_index) + 1
              if (
                ethereumNextEpoch < expectedNextEpoch ||
                solanaNextEpoch < expectedNextEpoch
              ) {
                return false
              }
              checkpoint = {
                epochIndex: Number(state.current_epoch_index),
                activeGroup: [...current],
                ethereumNextEpoch,
                solanaNextEpoch
              }
              return true
            },
            Constants.recoveryDeadlineMs(4),
            Constants.PollIntervalMs
          )
          Assert.ok(checkpoint != null, "withheld checkpoint was not captured")
          ctx.outputs.set(WithheldScheduleCheckpointKey, checkpoint)
        },
        { timeoutMs: Constants.recoveryDeadlineMs(4) }
      )
    )

    // ── 11. Keep announced duty while both outposts accept later epochs ──
    ClusterBuildPhase.create(
      cluster,
      "HoldAnnouncedDuty",
      "The serving window remains intact while candidate publication is withheld"
    ).push(
      verifyStep(
        Actor.Sysio,
        "held-duty-remains-live",
        "two epochs land on Ethereum and Solana without changing the announced current group",
        async ctx => {
          const checkpoint = ctx.outputs.assert(WithheldScheduleCheckpointKey)
          await pollUntil(
            "both outposts advance twice while the depot duty remains held",
            async () => {
              const state =
                await Steps.contracts.sysio.epoch.readEpochState(ctx)
              const current =
                state.batch_op_groups[state.current_batch_op_group] ?? []
              if (
                Number(state.current_epoch_index) > checkpoint.epochIndex &&
                !sameGroup(current, checkpoint.activeGroup)
              ) {
                throw new Error(
                  `duty rotated before repair: ${checkpoint.activeGroup.join(",")} -> ${current.join(",")}`
                )
              }
              assertCompleteSchedule(state.batch_op_groups)
              Assert.equal(
                state.next_batch_op_groups.length,
                0,
                "a candidate was published before a replacement was provisioned"
              )
              return (
                Number(state.current_epoch_index) >=
                  checkpoint.epochIndex + Constants.RecoveryHeldEpochAdvances &&
                (await readEthereumNextEpoch(ctx)) >=
                  checkpoint.ethereumNextEpoch +
                    Constants.RecoveryHeldEpochAdvances &&
                (await readSolanaNextEpoch(ctx)) >=
                  checkpoint.solanaNextEpoch +
                    Constants.RecoveryHeldEpochAdvances
              )
            },
            Constants.recoveryDeadlineMs(
              Constants.RecoveryHeldEpochAdvances + 4
            ),
            Constants.PollIntervalMs
          )
        },
        {
          timeoutMs: Constants.recoveryDeadlineMs(
            Constants.RecoveryHeldEpochAdvances + 4
          )
        }
      )
    )

    // ── 12. Lose a member of held duty without changing its announced seats ──
    ClusterBuildPhase.create(
      cluster,
      "DegradeHeldDuty",
      "An announced seat becomes ineligible while no next window is published"
    ).push(
      ClusterBuildStep.create(
        Actor.Sysio,
        "slash-held-member",
        "slash one eligible held-group member selected from live chain state",
        {},
        null,
        runSlashHeldGroupMember
      ),
      verifyStep(
        Actor.Sysio,
        "held-seat-preserved",
        "the next epoch retains the announced seat as a denominator placeholder",
        async ctx => {
          const withheld = ctx.outputs.assert(WithheldScheduleCheckpointKey)
          const slashedAccount = ctx.outputs.assert(HeldSlashAccountKey)
          const slashEpoch = ctx.outputs.assert(HeldSlashEpochKey)
          await pollUntil(
            "held duty survives a member becoming ineligible",
            async () => {
              const state =
                await Steps.contracts.sysio.epoch.readEpochState(ctx)
              const current =
                state.batch_op_groups[state.current_batch_op_group] ?? []
              if (!sameGroup(current, withheld.activeGroup)) {
                throw new Error(
                  `held duty changed after ${slashedAccount} was slashed: ${withheld.activeGroup.join(",")} -> ${current.join(",")}`
                )
              }
              Assert.ok(
                state.next_batch_op_groups.length === 0,
                "schedule became complete before replacements were provisioned"
              )
              if (
                Number(state.current_epoch_index) <= slashEpoch ||
                !(await operatorIsSlashed(ctx, slashedAccount))
              ) {
                return false
              }
              const [ethereumNextEpoch, solanaNextEpoch] = await Promise.all([
                readEthereumNextEpoch(ctx),
                readSolanaNextEpoch(ctx)
              ])
              const expectedNextEpoch = Number(state.current_epoch_index) + 1
              return (
                ethereumNextEpoch >= expectedNextEpoch &&
                solanaNextEpoch >= expectedNextEpoch
              )
            },
            Constants.recoveryDeadlineMs(4),
            Constants.PollIntervalMs
          )
        },
        { timeoutMs: Constants.recoveryDeadlineMs(4) }
      )
    )

    // ── 13. Add ACTIVE standbys and their daemons for the two roster losses ──
    WireOperatorProvisioningTool.planOperatorAccountProvisioning(
      cluster,
      "ProvisionScheduleReplacement",
      "Provision two bootstrapped batch operators to repair both roster losses",
      {},
      Constants.RecoveryOperatorLabels.map((label, index) => ({
        label,
        type: OperatorType.BATCH,
        ethereumHdIndex: Constants.RecoveryOperatorEthereumHdIndices[index],
        isBootstrapped: true,
        airdropSolanaLamports:
          WireOperatorProvisioningTool.DefaultSolanaAirdropLamports
      }))
    )

    ClusterBuildPhase.create(
      cluster,
      "StartScheduleReplacementDaemons",
      "Start both replacement batch-operator daemons before they enter rotation"
    ).push(
      ...Constants.RecoveryOperatorLabels.map(label =>
        OperatorDaemonTool.planDaemonStart(
          Actor.BatchOperator,
          `start-${label}-daemon`,
          `start ${label}'s batch-operator daemon`,
          {},
          label
        )
      )
    )

    // ── 14. Repair and publish the future window without moving held duty ──
    ClusterBuildPhase.create(
      cluster,
      "RepairScheduleWindow",
      "The replacement completes and publishes lookahead without moving current duty"
    ).push(
      verifyStep(
        Actor.Sysio,
        "complete-window-published",
        "a complete candidate is published while the serving window is unchanged",
        async ctx => {
          const withheld = ctx.outputs.assert(WithheldScheduleCheckpointKey)
          const replacements = Constants.RecoveryOperatorLabels.map(
            label => ctx.keyStore.assertOperator(label).account
          )
          let checkpoint: RepairedScheduleCheckpoint | null = null
          await pollUntil(
            "the replacement enables a complete next-window announcement",
            async () => {
              const state =
                await Steps.contracts.sysio.epoch.readEpochState(ctx)
              const groups = state.next_batch_op_groups
              const current =
                state.batch_op_groups[state.current_batch_op_group] ?? []
              const complete =
                groups.length === Constants.BatchOperatorGroups &&
                groups.every(
                  group => group.length === Constants.OperatorsPerEpoch
                )
              if (
                !complete ||
                !groups.some(group =>
                  group.some(member => replacements.includes(member))
                )
              ) {
                return false
              }
              Assert.ok(
                sameGroup(current, withheld.activeGroup),
                "current duty moved before the repaired lookahead was published"
              )
              assertCompleteSchedule(groups)
              const nextGroup = groups[1] ?? groups[0]
              const [ethereumNextEpoch, solanaNextEpoch] = await Promise.all([
                readEthereumNextEpoch(ctx),
                readSolanaNextEpoch(ctx)
              ])
              const expectedNextEpoch = Number(state.current_epoch_index) + 1
              if (
                ethereumNextEpoch < expectedNextEpoch ||
                solanaNextEpoch < expectedNextEpoch
              ) {
                return false
              }
              checkpoint = {
                epochIndex: Number(state.current_epoch_index),
                activeGroup: [...current],
                nextGroup: [...nextGroup],
                ethereumNextEpoch,
                solanaNextEpoch
              }
              return true
            },
            Constants.recoveryDeadlineMs(4),
            Constants.PollIntervalMs
          )
          Assert.ok(checkpoint != null, "repaired checkpoint was not captured")
          ctx.outputs.set(RepairedScheduleCheckpointKey, checkpoint)
        },
        { timeoutMs: Constants.recoveryDeadlineMs(4) }
      )
    )

    // ── 15. Rotate only after the repaired lookahead has been published ──
    ClusterBuildPhase.create(
      cluster,
      "ResumeScheduleRotation",
      "The next published group takes duty and both outposts remain sequential"
    ).push(
      verifyStep(
        Actor.Sysio,
        "rotation-resumes-after-publication",
        "the announced next group serves an epoch accepted by Ethereum and Solana",
        async ctx => {
          const repaired = ctx.outputs.assert(RepairedScheduleCheckpointKey)
          await pollUntil(
            "the repaired next group serves an epoch accepted by both outposts",
            async () => {
              const state =
                await Steps.contracts.sysio.epoch.readEpochState(ctx)
              const current =
                state.batch_op_groups[state.current_batch_op_group] ?? []
              const [ethereumNextEpoch, solanaNextEpoch] = await Promise.all([
                readEthereumNextEpoch(ctx),
                readSolanaNextEpoch(ctx)
              ])
              const expectedNextEpoch = Number(state.current_epoch_index) + 1
              return (
                Number(state.current_epoch_index) > repaired.epochIndex &&
                sameGroup(current, repaired.nextGroup) &&
                ethereumNextEpoch >= expectedNextEpoch &&
                solanaNextEpoch >= expectedNextEpoch
              )
            },
            Constants.recoveryDeadlineMs(4),
            Constants.PollIntervalMs
          )
        },
        { timeoutMs: Constants.recoveryDeadlineMs(4) }
      )
    )

    // ── 16. Prove each replacement is seated and delivers on both outposts ──
    ClusterBuildPhase.create(
      cluster,
      "ExerciseScheduleReplacement",
      "Each replacement signs an accepted duty epoch on Ethereum and Solana"
    ).push(
      verifyStep(
        Actor.Sysio,
        "replacement-groups-ready",
        "both replacements are seated in a complete, fully active window",
        async ctx => {
          const replacements = Constants.RecoveryOperatorLabels.map(
            label => ctx.keyStore.assertOperator(label).account
          )
          await pollUntil(
            "historical vacancies leave the activated window",
            async () => {
              const state =
                await Steps.contracts.sysio.epoch.readEpochState(ctx)
              const active = await readActiveBatchOperatorAccounts(ctx)
              assertCompleteSchedule(state.batch_op_groups)
              const members = state.batch_op_groups.flat()
              return (
                members.every(account => active.has(account)) &&
                replacements.every(account => members.includes(account))
              )
            },
            Constants.recoveryDeadlineMs(Constants.BatchOperatorGroups + 1),
            Constants.PollIntervalMs
          )
        },
        {
          timeoutMs: Constants.recoveryDeadlineMs(Constants.BatchOperatorGroups + 1)
        }
      ),
      // A late third signature is a valid no-op after quorum. Stop one original
      // peer per replacement group so each replacement must be admitted.
      // The groups may be shared or distinct; every group retains two signers.
      ...Constants.RecoveryOperatorLabels.map(label =>
        ClusterBuildStep.create(
          Actor.BatchOperator,
          `stop-${label}-peer`,
          `stop an original group peer so ${label} is required for quorum`,
          {},
          { kind: "TerminationScenario.StopReplacementPeerInput", label },
          runStopReplacementPeer
        )
      ),
      verifyStep(
        Actor.BatchOperator,
        "replacement-duty-serves",
        "each replacement is admitted as an active-group signer on Ethereum and Solana",
        async ctx => {
          const replacements = Constants.RecoveryOperatorLabels.map(
            label => ctx.keyStore.assertOperator(label).account
          )
          const dutyEpochs = new Map<string, Set<number>>()
          const delivered = new Set<string>()
          await pollUntil(
            "each replacement signs an accepted duty epoch on both outposts",
            async () => {
              const state =
                await Steps.contracts.sysio.epoch.readEpochState(ctx)
              const current =
                state.batch_op_groups[state.current_batch_op_group] ?? []
              const currentEpoch = Number(state.current_epoch_index)
              for (const replacement of replacements) {
                if (current.includes(replacement) && !delivered.has(replacement)) {
                  const epochs = dutyEpochs.get(replacement) ?? new Set<number>()
                  epochs.add(currentEpoch)
                  dutyEpochs.set(replacement, epochs)
                }
              }
              assertCompleteSchedule(state.batch_op_groups)
              const [ethereumNextEpoch, solanaNextEpoch] = await Promise.all([
                readEthereumNextEpoch(ctx),
                readSolanaNextEpoch(ctx)
              ])
              for (const replacement of replacements) {
                if (delivered.has(replacement)) continue
                // A delivery arriving after quorum is a benign no-op. Keep
                // later observed duties eligible instead of pinning the first.
                for (const dutyEpoch of dutyEpochs.get(replacement) ?? []) {
                  if (
                    ethereumNextEpoch >= dutyEpoch + 1 &&
                    solanaNextEpoch >= dutyEpoch + 1 &&
                    (await replacementDeliveredOnBothOutposts(
                      ctx,
                      replacement,
                      dutyEpoch
                    ))
                  ) {
                    delivered.add(replacement)
                    log.info(
                      `${replacement} signed accepted deliveries on both outposts for duty epoch ${dutyEpoch}`
                    )
                    break
                  }
                }
              }
              return delivered.size === replacements.length
            },
            Constants.recoveryDeadlineMs(Constants.BatchOperatorGroups + 4),
            Constants.PollIntervalMs
          )
        },
        {
          timeoutMs: Constants.recoveryDeadlineMs(
            Constants.BatchOperatorGroups + 4
          )
        }
      )
    )
  }
}
