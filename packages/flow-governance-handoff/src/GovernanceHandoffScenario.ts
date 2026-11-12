import Assert from "node:assert"
import {
  ABI,
  Action,
  KeyType,
  PrivateKey,
  SignedTransaction,
  SysioContracts,
  Transaction
} from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  Constants as HarnessConstants,
  FlowScenario,
  getLogger,
  KeyGenerator,
  NodeConfig,
  NodeOwnerTier,
  outputKey,
  pollUntil,
  ProtocolTiming,
  Report,
  Steps,
  supermajorityThreshold,
  verifyStep,
  WireAuthorityAuditTool,
  WireClient,
  WireNodeOwnerTool,
  WireSysioContractTool,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { GovernanceHandoffScenarioConstants as Constants } from "./GovernanceHandoffScenarioConstants.js"

const log = getLogger(__filename)

const { SysioContractName, SysioContractAccount } = SysioContracts
const { Actor } = Report
const { AuditPhase } = WireAuthorityAuditTool
const { governance: Governance } = Steps
const {
  commit: CommitSteps,
  mint: MintSteps,
  registration: RegistrationSteps
} = Steps.nodeOwner
const MsigSteps = Steps.contracts.sysio.msig

/**
 * The tier-1 roster `sysio.nodes@active` was last synced to, recorded by the
 * verify that follows each `syncnodes` — what the authority must equal until
 * the next one.
 */
export const SyncedRosterKey = outputKey<string[]>(
  "GovernanceHandoffScenario.syncedRoster",
  "the tier-1 roster sysio.nodes@active was last synced to"
)

/**
 * The roster {@link SyncedRosterKey} held before its latest re-sync, for
 * comparing thresholds across one.
 */
export const PreviousRosterKey = outputKey<string[]>(
  "GovernanceHandoffScenario.previousRoster",
  "the tier-1 roster sysio.nodes@active held before its latest re-sync"
)

/** Every step's ceiling: finality waits plus push retries. */
const StepOptions = { timeoutMs: Constants.StepTimeoutMs }
/** An authority audit's ceiling: it scans the chain's whole trace history. */
const AuditOptions = { timeoutMs: Constants.AuditTimeoutMs }
/** The owner who proposes and executes every probe proposal. */
const [Proposer] = Constants.InitialNodeOwners

/**
 * The `active` permission level of each account, in order — an msig `requested`
 * list, or one approving level.
 *
 * @param accounts - The accounts.
 * @returns Each account's `active`.
 */
export function activeLevels(
  accounts: ReadonlyArray<string>
): SysioContracts.SysioMsigPermissionLevelType[] {
  return accounts.map(actor => ({ actor, permission: WireClient.ActivePermission }))
}

/**
 * The public key of a flow identity: its seeded development K1 key.
 *
 * @param account - The identity's account.
 * @returns The key its account is created and registered with.
 */
export function flowPublicKey(account: string): string {
  return KeyGenerator.createSeeded(KeyType.K1, Constants.keySeed(account)).publicKey
}

/**
 * A probe governance action: `sysio.token::transfer` of
 * {@link Constants.ProbeTransferQuantity} WIRE from `sysio` to `recipient`,
 * declared by `sysio@active` — harmless, and observable as the recipient's
 * balance.
 *
 * @param recipient - The account paid.
 * @returns The typed action.
 */
export function probeTransfer(
  recipient: string
): WireClient.ActionPayload<SysioContracts.SysioContractName.token, "transfer"> {
  return {
    contract: SysioContractName.token,
    account: SysioContractAccount[SysioContractName.token],
    name: "transfer",
    authorization: WireClient.activeAuthorization(HarnessConstants.SYSIO_ACCOUNT),
    data: {
      from: HarnessConstants.SYSIO_ACCOUNT,
      to: recipient,
      quantity: Constants.ProbeTransferQuantity,
      memo: Constants.ProbeTransferMemo
    }
  }
}

/**
 * The governance action that writes the stand-in council into
 * `sysio.cncl@active` — what `sysio.councl` does itself when an election fills
 * its last seat. Declared by `sysio.cncl@owner`, which is `sysio@active`.
 *
 * @returns The typed action.
 */
export function setCouncilAction(): WireClient.ActionPayload<
  SysioContracts.SysioContractName.system,
  "updateauth"
> {
  return {
    contract: SysioContractName.system,
    account: HarnessConstants.SYSIO_ACCOUNT,
    name: "updateauth",
    authorization: [
      {
        actor: HarnessConstants.COUNCIL_AUTHORITY,
        permission: WireClient.OwnerPermission
      }
    ],
    data: {
      account: HarnessConstants.COUNCIL_AUTHORITY,
      permission: WireClient.ActivePermission,
      parent: WireClient.OwnerPermission,
      auth: Governance.supermajorityAuthority(Constants.CouncilMembers)
    }
  }
}

/**
 * The bootstrap `sysio` key the handoff retires: the genesis identity's K1.
 *
 * @param ctx - The build context.
 * @returns The key.
 */
export function bootstrapKey(ctx: ClusterBuildContext): string {
  return ctx.keyStore.assertOperator(NodeConfig.BiosName).wire.publicKey
}

/**
 * A governance authority account was created with `owner` = `sysio@active`,
 * the unsatisfiable `sysio.null@active` placeholder `active`, and room for 21
 * members' worth of RAM.
 *
 * @param ctx - The build context.
 * @param account - The governance authority account.
 */
export async function assertGovernanceAuthorityCreated(
  ctx: ClusterBuildContext,
  account: HarnessConstants.GovernanceAuthorityAccount
): Promise<void> {
  const [owner, active] = await Promise.all([
      Governance.readAuthority(ctx.wire, account, WireClient.OwnerPermission),
      Governance.readAuthority(ctx.wire, account, WireClient.ActivePermission)
    ]),
    { ram_quota: ramQuota, ram_usage: ramUsage } =
      await ctx.wire.api.v1.chain.get_account(account)
  Assert.deepStrictEqual(
    owner,
    WireSysioContractTool.sysioActiveAuthority(),
    `${account}@owner must be sysio@active`
  )
  Assert.deepStrictEqual(
    active,
    WireSysioContractTool.sysioNullActiveAuthority(),
    `${account}@active must be the unsatisfiable ${HarnessConstants.NULL_ACCOUNT}@active placeholder`
  )
  Assert.ok(
    Number(ramQuota) - Number(ramUsage) >= HarnessConstants.GOVERNANCE_AUTHORITY_RAM_BYTES,
    `${account} must have ${HarnessConstants.GOVERNANCE_AUTHORITY_RAM_BYTES} bytes free for its members (quota ${ramQuota}, usage ${ramUsage})`
  )
}

/**
 * `owner` holds a tier-1 `nodeowners` row in the live network generation.
 *
 * @param ctx - The build context.
 * @param owner - The node owner.
 */
export async function assertTierOneOwner(
  ctx: ClusterBuildContext,
  owner: string
): Promise<void> {
  Assert.strictEqual(
    Number((await WireNodeOwnerTool.readNodeOwner(ctx.wire, owner))?.tier),
    NodeOwnerTier.T1,
    `${owner} must be registered at tier 1`
  )
}

/**
 * `sysio.nodes@active` is exactly the on-chain tier-1 roster, sorted, at the
 * supermajority threshold. Records the roster under {@link SyncedRosterKey},
 * and the one it replaces under {@link PreviousRosterKey}.
 *
 * @param ctx - The build context.
 */
export async function assertNodeOwnerAuthorityIsRoster(
  ctx: ClusterBuildContext
): Promise<void> {
  const roster = await WireNodeOwnerTool.readTierNodeOwners(ctx.wire, NodeOwnerTier.T1),
    authority = await Governance.readAuthority(
      ctx.wire,
      HarnessConstants.NODE_OWNERS_AUTHORITY,
      WireClient.ActivePermission
    )
  Assert.deepStrictEqual(
    authority,
    Governance.supermajorityAuthority(roster),
    `sysio.nodes@active must be the tier-1 roster [${roster.join(", ")}] at ${supermajorityThreshold(roster.length)}`
  )
  const previous = ctx.outputs.get(SyncedRosterKey)
  if (previous != null) ctx.outputs.set(PreviousRosterKey, previous)
  ctx.outputs.set(SyncedRosterKey, roster)
  log.info(
    `sysio.nodes@active = [${roster.join(", ")}] at ${authority.threshold} of ${roster.length}`
  )
}

/**
 * The handoff's own `syncnodes` ran: `sysio.nodes@active` is the full roster
 * ({@link assertNodeOwnerAuthorityIsRoster}), every initial owner is on it, and
 * {@link Constants.HandoffNodeOwner} — registered after the last standalone
 * `syncnodes` — was not on the roster it replaced.
 *
 * @param ctx - The build context.
 */
export async function assertHandoffSyncedRoster(ctx: ClusterBuildContext): Promise<void> {
  await assertNodeOwnerAuthorityIsRoster(ctx)
  const synced = ctx.outputs.assert(SyncedRosterKey),
    previous = ctx.outputs.assert(PreviousRosterKey)
  Assert.ok(
    !previous.includes(Constants.HandoffNodeOwner),
    `${Constants.HandoffNodeOwner} must not have been on sysio.nodes@active before the handoff`
  )
  Constants.InitialNodeOwners.forEach(owner =>
    Assert.ok(synced.includes(owner), `${owner} must be on sysio.nodes@active after the handoff`)
  )
}

/**
 * The roster `sysio.nodes@active` was last synced to is exactly `owners`. The
 * bootstrap registers no tier-1 owner, so every member is one the flow
 * registered, and the thresholds the probes count against follow from the
 * flow's own counts.
 *
 * @param ctx - The build context.
 * @param owners - The flow owners registered so far.
 */
export async function assertRosterIsFlowOwners(
  ctx: ClusterBuildContext,
  owners: ReadonlyArray<string>
): Promise<void> {
  const roster = ctx.outputs.assert(SyncedRosterKey)
  Assert.deepStrictEqual(
    roster,
    [...owners].sort(WireSysioContractTool.compareNames),
    `the tier-1 roster [${roster.join(", ")}] must be exactly the flow's owners [${owners.join(", ")}]`
  )
}

/**
 * The roster is exactly the initial flow owners, and their number is its
 * threshold (3 of 3), so the plan's "one approval short" probe is short by
 * exactly one.
 *
 * @param ctx - The build context.
 */
export async function assertFlowOwnersMeetThreshold(
  ctx: ClusterBuildContext
): Promise<void> {
  await assertRosterIsFlowOwners(ctx, Constants.InitialNodeOwners)
  const threshold = supermajorityThreshold(ctx.outputs.assert(SyncedRosterKey).length)
  Assert.strictEqual(
    threshold,
    Constants.InitialNodeOwners.length,
    `the ${Constants.InitialNodeOwners.length} initial owners must exactly meet the threshold ${threshold}`
  )
}

/**
 * The re-sync after the late owner made the roster exactly every flow owner,
 * and left the threshold where the previous roster had it (3 of 3, then 3 of
 * 4). The late-owner probes count against that unchanged threshold: the late
 * owner's approval stands in for an initial owner's, and the three initial
 * owners' approvals still suffice.
 *
 * @param ctx - The build context.
 */
export async function assertLateOwnerKeepsThreshold(
  ctx: ClusterBuildContext
): Promise<void> {
  await assertRosterIsFlowOwners(ctx, Constants.NodeOwners)
  const previous = ctx.outputs.assert(PreviousRosterKey),
    roster = ctx.outputs.assert(SyncedRosterKey),
    previousThreshold = supermajorityThreshold(previous.length),
    threshold = supermajorityThreshold(roster.length)
  Assert.strictEqual(
    threshold,
    previousThreshold,
    `the late owner must leave the threshold unchanged: ${previousThreshold} of ${previous.length}, now ${threshold} of ${roster.length}`
  )
}

/**
 * Audit every permission of every system account; fail on anything the audit
 * cannot classify or any authority that differs from the one expected. After
 * a handoff, also fail when the bootstrap key alone still satisfies anything
 * but the `sysio.andon` panic permissions.
 *
 * @param ctx - The build context.
 * @param signal - The step's cancellation.
 * @param phase - Whether `sysio` has been handed over yet.
 * @param handedTo - After a handoff, the authority `sysio` was handed to.
 * @param councilMembers - The members a written `sysio.cncl@active` must hold.
 */
export async function auditAuthorities(
  ctx: ClusterBuildContext,
  signal: AbortSignal,
  phase: WireAuthorityAuditTool.AuditPhase,
  handedTo?: HarnessConstants.GovernanceAuthorityAccount,
  councilMembers?: ReadonlyArray<string>
): Promise<void> {
  const key = bootstrapKey(ctx),
    inventory = await WireAuthorityAuditTool.discoverSystemAccounts(ctx.wire, signal),
    result = await WireAuthorityAuditTool.audit(ctx.wire, {
      accounts: inventory.accounts,
      panicAccount: HarnessConstants.PANIC_ACCOUNT,
      keys: [key],
      phase,
      handedTo,
      councilMembers
    })
  WireAuthorityAuditTool.describe(result, inventory).forEach(line =>
    log.info(`[authority audit] ${line}`)
  )
  WireAuthorityAuditTool.assertClean(result, inventory)
  if (phase === AuditPhase.afterHandoff) WireAuthorityAuditTool.assertKeyRetired(result, key)
}

/**
 * `sysio@active` and `sysio@owner` both delegate to `authority@active` alone.
 *
 * @param ctx - The build context.
 * @param authority - The governance authority.
 */
export async function assertHandedTo(
  ctx: ClusterBuildContext,
  authority: HarnessConstants.GovernanceAuthorityAccount
): Promise<void> {
  const expected = WireSysioContractTool.delegatedAuthority(authority)
  await Promise.all(
    [WireClient.ActivePermission, WireClient.OwnerPermission].map(async permission =>
      Assert.deepStrictEqual(
        await Governance.readAuthority(ctx.wire, HarnessConstants.SYSIO_ACCOUNT, permission),
        expected,
        `${HarnessConstants.SYSIO_ACCOUNT}@${permission} must delegate to ${authority}@active`
      )
    )
  )
}

/**
 * A `sysio@active` action signed by the bootstrap key ALONE is refused — the
 * transaction is signed here with that one key, not through the wallet, which
 * also holds the flow owners' keys.
 *
 * @param ctx - The build context.
 */
export async function assertBootstrapKeyRefused(
  ctx: ClusterBuildContext
): Promise<void> {
  const identity = ctx.keyStore.assertOperator(NodeConfig.BiosName).wire
  Assert.ok(
    identity.privateKey != null,
    "the bootstrap key's private half must be in the key store (KEY signature provider)"
  )
  const action = probeTransfer(Constants.CouncilMembers[0]),
    abi = ABI.from((await ctx.wire.api.v1.chain.get_abi(action.account)).abi),
    info = await ctx.wire.api.v1.chain.get_info(),
    transaction = Transaction.from({
      ...info.getTransactionHeader(Constants.SignedProbeExpirationSec),
      actions: [
        Action.from(
          {
            account: action.account,
            name: action.name,
            authorization: [...action.authorization],
            data: action.data
          },
          abi
        )
      ]
    }),
    signature = PrivateKey.from(identity.privateKey).signDigest(
      transaction.signingDigest(info.chain_id).msgDigest
    )
  await Assert.rejects(
    ctx.wire.api.v1.chain.push_transaction(
      SignedTransaction.from({ ...transaction, signatures: [signature] })
    ),
    (error: Error) => {
      log.info(`bootstrap-key probe refused: ${error.message}`)
      return Constants.UnsatisfiedAuthorizationPattern.test(error.message)
    }
  )
}

/**
 * The `sysio.msig::exec` data every probe proposal uses: proposed and executed
 * by the first owner.
 *
 * @param proposalName - The proposal.
 * @returns The generated exec data.
 */
export function execData(proposalName: string): SysioContracts.SysioMsigExecAction {
  return { proposer: Proposer, proposal_name: proposalName, executer: Proposer }
}

/**
 * The proposal's dry-run `exec` answers `executable` now, read without
 * executing it ({@link MsigSteps.isExecutable}).
 *
 * @param ctx - The build context.
 * @param proposalName - The proposal.
 * @param executable - Whether it must be executable.
 */
export async function assertExecutable(
  ctx: ClusterBuildContext,
  proposalName: string,
  executable: boolean
): Promise<void> {
  Assert.strictEqual(
    await MsigSteps.isExecutable(ctx.wire, execData(proposalName)),
    executable,
    `${Proposer}/${proposalName} must ${executable ? "" : "not "}be executable now`
  )
}

/**
 * The probe recipient holds exactly one probe transfer — its proposal executed once.
 *
 * @param ctx - The build context.
 * @param recipient - The probe's recipient.
 */
export async function assertProbePaid(
  ctx: ClusterBuildContext,
  recipient: string
): Promise<void> {
  Assert.strictEqual(
    await ctx.wire.getWireBalance(recipient),
    Constants.ProbeTransferUnits,
    `${recipient} must hold exactly ${Constants.ProbeTransferQuantity}`
  )
}

/**
 * The late owner's NFT claim reached the depot over OPP: a tier-1 `nodeowners` row.
 *
 * @param ctx - The build context.
 */
export async function assertLateOwnerRegistered(
  ctx: ClusterBuildContext
): Promise<void> {
  await pollUntil(
    `nodeowners row for ${Constants.LateNodeOwner} via OPP`,
    async () => (await WireNodeOwnerTool.readNodeOwner(ctx.wire, Constants.LateNodeOwner)) != null,
    Constants.LateOwnerDeadlineMs,
    Constants.LateOwnerPollIntervalMs
  )
  await assertTierOneOwner(ctx, Constants.LateNodeOwner)
}

/**
 * `owner` is on the live roster, yet `sysio.nodes@active` is still the roster
 * it was last synced to: nothing changes until `syncnodes`.
 *
 * @param ctx - The build context.
 * @param owner - The owner registered after the last `syncnodes`.
 */
export async function assertUnsyncedOwner(
  ctx: ClusterBuildContext,
  owner: string
): Promise<void> {
  const synced = ctx.outputs.assert(SyncedRosterKey),
    roster = await WireNodeOwnerTool.readTierNodeOwners(ctx.wire, NodeOwnerTier.T1)
  Assert.ok(roster.includes(owner), `${owner} must be on the roster`)
  Assert.ok(!synced.includes(owner), `${owner} must not be on the synced roster`)
  Assert.deepStrictEqual(
    await Governance.readAuthority(
      ctx.wire,
      HarnessConstants.NODE_OWNERS_AUTHORITY,
      WireClient.ActivePermission
    ),
    Governance.supermajorityAuthority(synced),
    "sysio.nodes@active must still be the previously synced roster"
  )
}

/**
 * `sysio.cncl@active` is the stand-in council at its supermajority.
 *
 * @param ctx - The build context.
 */
export async function assertCouncilAuthority(ctx: ClusterBuildContext): Promise<void> {
  Assert.deepStrictEqual(
    await Governance.readAuthority(
      ctx.wire,
      HarnessConstants.COUNCIL_AUTHORITY,
      WireClient.ActivePermission
    ),
    Governance.supermajorityAuthority(Constants.CouncilMembers),
    "sysio.cncl@active must be the stand-in council"
  )
}

/**
 * The node owners can no longer even propose a `sysio@active` action: a
 * dry-run `propose` ({@link MsigSteps.isProposable}) is refused, because their
 * approvals could not authorize it. Nothing is written.
 *
 * @param ctx - The build context.
 */
export async function assertNodeOwnersCannotPropose(
  ctx: ClusterBuildContext
): Promise<void> {
  Assert.strictEqual(
    await MsigSteps.isProposable(ctx.wire, {
      kind: "MsigContractSteps.ProposeInput",
      data: {
        proposer: Proposer,
        proposal_name: Constants.RefusedProposal,
        requested: activeLevels(Constants.NodeOwners)
      },
      actions: [probeTransfer(Constants.CouncilMembers[0])]
    }),
    false,
    "the node owners must not be able to propose a sysio@active action"
  )
}

/**
 * The `sysio.msig::propose` step of a probe proposal, by the first owner.
 *
 * @param proposalName - The proposal.
 * @param requested - The accounts asked to approve, each through its `active`.
 * @param actions - The proposed actions.
 * @param description - What the proposal is.
 * @returns The step.
 */
export function planProposal(
  proposalName: string,
  requested: ReadonlyArray<string>,
  actions: ReadonlyArray<WireClient.AnyActionPayload>,
  description: string
): ReturnType<typeof MsigSteps.planPropose> {
  return MsigSteps.planPropose(
    Actor.User,
    `propose-${proposalName}`,
    description,
    StepOptions,
    { proposer: Proposer, proposal_name: proposalName, requested: activeLevels(requested) },
    actions
  )
}

/**
 * One `sysio.msig::approve` step per approving account, in order.
 *
 * @param proposalName - The proposal approved.
 * @param approvers - The approving accounts, each signing its own `active`.
 * @returns The steps.
 */
export function planApprovals(
  proposalName: string,
  approvers: ReadonlyArray<string>
): ReturnType<typeof MsigSteps.planApprove>[] {
  return approvers.map(approver =>
    MsigSteps.planApprove(
      Actor.User,
      `approve-${proposalName}-${approver}`,
      `${approver} approves ${proposalName}`,
      StepOptions,
      {
        proposer: Proposer,
        proposal_name: proposalName,
        level: { actor: approver, permission: WireClient.ActivePermission }
      }
    )
  )
}

/**
 * The probe proposal's `sysio.msig::exec`, by its proposer.
 *
 * @param proposalName - The proposal executed.
 * @returns The step.
 */
export function planProbeExec(
  proposalName: string
): ReturnType<typeof MsigSteps.planExec> {
  return MsigSteps.planExec(
    Actor.User,
    `exec-${proposalName}`,
    `${Proposer} executes ${proposalName}`,
    StepOptions,
    execData(proposalName)
  )
}

/**
 * A verify that the proposal's dry-run `exec` answers `executable` now.
 *
 * @param name - The step's name.
 * @param proposalName - The proposal.
 * @param executable - Whether it must be executable.
 * @param why - What the answer shows.
 * @returns The verify step.
 */
export function verifyExecutable(
  name: string,
  proposalName: string,
  executable: boolean,
  why: string
): ReturnType<typeof verifyStep> {
  return verifyStep(
    Actor.Sysio,
    name,
    why,
    ctx => assertExecutable(ctx, proposalName, executable),
    StepOptions
  )
}

/**
 * A verify that the probe recipient was paid exactly once.
 *
 * @param recipient - The probe's recipient.
 * @returns The verify step.
 */
export function verifyProbePaid(recipient: string): ReturnType<typeof verifyStep> {
  return verifyStep(
    Actor.Sysio,
    `paid-${recipient}`,
    `${recipient} holds exactly ${Constants.ProbeTransferQuantity}`,
    ctx => assertProbePaid(ctx, recipient),
    StepOptions
  )
}

/**
 * The steps that register one initial tier-1 owner through
 * `sysio.roa::nodeownreg`, the claim the depot dispatches, which creates the
 * owner's account under its own key; then read the registration back.
 *
 * @param owner - The owner.
 * @param ethereumHdIndex - The anvil HD index of the owner's depositor EM key.
 * @returns The steps.
 */
export function planInitialOwner(
  owner: string,
  ethereumHdIndex: number
): Array<
  | ReturnType<typeof RegistrationSteps.planRegisterNodeOwner>
  | ReturnType<typeof verifyStep>
> {
  return [
    RegistrationSteps.planRegisterNodeOwner(
      Actor.User,
      `register-${owner}`,
      `create and register ${owner} at tier 1 under its own key`,
      StepOptions,
      owner,
      NodeOwnerTier.T1,
      ethereumHdIndex,
      flowPublicKey(owner)
    ),
    verifyStep(
      Actor.Sysio,
      `registered-${owner}`,
      `${owner} holds a tier-1 nodeowners row`,
      ctx => assertTierOneOwner(ctx, owner),
      StepOptions
    )
  ]
}

/**
 * Governance handoff rehearsal — tier-1 node owners take `sysio`, govern it by
 * msig, absorb a late owner, and hand it on to a council. The bootstrap
 * registers no tier-1 owner, so the roster is only the owners the flow
 * registers, and every threshold follows from its counts: `floor(2N/3)+1` is
 * 2 of 2, then 3 of 3, then 3 of 4.
 *
 * 1. **GovernanceAuthorityAccounts** — the bootstrap created `sysio.nodes` and
 *    `sysio.cncl` (owner `sysio@active`, unsatisfiable `active`, member RAM).
 * 2. **NodeOwners** / **NodeOwnerAuthority** — two tier-1 owners register
 *    under keys the flow controls; `syncnodes` makes `sysio.nodes@active` the
 *    on-chain roster (2 of 2).
 * 3. **PreHandoffAudit** — every permission of every system account is
 *    governance or a documented exception.
 * 4. **HandoffNodeOwner** / **Handoff** — a third owner registers after that
 *    `syncnodes`, so `sysio.nodes@active` lacks it; one transaction
 *    (`syncnodes`, then `sysio@active`, then `sysio@owner` →
 *    `sysio.nodes@active`) signed by the bootstrap key leaves
 *    `sysio.nodes@active` the full roster, the third owner included (3 of 3).
 *    The audit re-runs, the bootstrap key alone now satisfies only the
 *    `sysio.andon` panic permissions, and a `sysio@active` action it signs is
 *    refused.
 * 5. **NodeOwnerMsig** — one approval short, a dry-run `exec` is refused; at
 *    the threshold it executes and pays its probe.
 * 6. **LateNodeOwner** / **PreviousRosterGoverns** / **NewRoster** — a fourth
 *    owner claims through `BAR.commitNode` over OPP, which leaves the
 *    threshold at 3 (3 of 4). Before `syncnodes` the three initial owners'
 *    approvals are executable and the late owner's with two initial owners are
 *    not; after it, both are executable: the late owner's approval now counts,
 *    and the initial owners' still meet the unchanged threshold. The late
 *    owner's proposal then executes and pays its probe.
 * 7. **StandInCouncil** … **CouncilGoverns** — the node owners write a
 *    stand-in council into `sysio.cncl@active` and hand `sysio` to it; the
 *    council governs, and the node owners cannot, even after another
 *    `syncnodes`. A real election needs exactly 21 tier-1 owners and is out of
 *    this flow's scope.
 */
export class GovernanceHandoffScenario extends FlowScenario {
  readonly name = "flow-governance-handoff"
  readonly description =
    "Tier-1 node owners take sysio through sysio.nodes, govern it by msig, absorb a late owner, then hand it to a stand-in council"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount
  }

  plan(cluster: ClusterBuild): void {
    const ownerAccounts: ReadonlyArray<string> = Constants.NodeOwners,
      councilThreshold = supermajorityThreshold(Constants.CouncilMembers.length),
      initialThreshold = supermajorityThreshold(Constants.InitialNodeOwners.length),
      rosterThreshold = supermajorityThreshold(Constants.NodeOwners.length)

    // ── 1. The governance authorities exist, unwritten ──
    ClusterBuildPhase.create(
      cluster,
      "GovernanceAuthorityAccounts",
      "sysio.nodes + sysio.cncl: owner sysio@active, active sysio.null@active, RAM for 21 members"
    ).push(
      ...HarnessConstants.GOVERNANCE_AUTHORITY_ACCOUNTS.map(account =>
        verifyStep(
          Actor.Sysio,
          `created-${account}`,
          `${account} was created unwritten with room for its members`,
          ctx => assertGovernanceAuthorityCreated(ctx, account),
          StepOptions
        )
      )
    )

    // ── 2. The flow's identities: keys, council accounts, the first owners ──
    ClusterBuildPhase.create(
      cluster,
      "FlowKeys",
      "Import the seeded key of every owner and stand-in council member the flow controls"
    ).push(
      ...[...Constants.NodeOwners, ...Constants.CouncilMembers].map(account =>
        Steps.keys.planImportSeededKey(
          Actor.User,
          `import-key-${account}`,
          `import ${account}'s key into the wallet`,
          StepOptions,
          Constants.keySeed(account)
        )
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "CouncilAccounts",
      "Create the stand-in council members' accounts while sysio still signs alone"
    ).push(
      ...Constants.CouncilMembers.map(member =>
        Steps.account.planCreateKeyed(
          Actor.Sysio,
          `create-${member}`,
          `create ${member} under its own key`,
          StepOptions,
          member,
          flowPublicKey(member)
        )
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "NodeOwners",
      "Register the first tier-1 owners through sysio.roa::nodeownreg, the claim the depot dispatches"
    ).push(
      ...Constants.PreSyncNodeOwners.flatMap((owner, index) =>
        planInitialOwner(owner, Constants.FirstDepositorEthereumHdIndex + index)
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "NodeOwnerAuthority",
      "syncnodes writes the on-chain tier-1 roster into sysio.nodes@active"
    ).push(
      Steps.contracts.sysio.councl.planSyncnodes(
        Actor.User,
        "syncnodes",
        `${Proposer} syncs sysio.nodes@active to the tier-1 roster`,
        StepOptions,
        { caller: Proposer }
      ),
      verifyStep(
        Actor.Sysio,
        "nodes-authority-is-roster",
        "sysio.nodes@active is exactly the roster, sorted, at floor(2N/3)+1",
        assertNodeOwnerAuthorityIsRoster,
        StepOptions
      )
    )

    // ── 3. Authority audit before the handoff ──
    ClusterBuildPhase.create(
      cluster,
      "PreHandoffAudit",
      "Every permission of every system account is governance or a documented exception"
    ).push(
      verifyStep(
        Actor.Sysio,
        "audit-before-handoff",
        "classify every key and delegation of every sysio.* account",
        (ctx, signal) => auditAuthorities(ctx, signal, AuditPhase.beforeHandoff),
        AuditOptions
      )
    )

    // ── 4. A third owner the standalone syncnodes missed, then the handoff ──
    ClusterBuildPhase.create(
      cluster,
      "HandoffNodeOwner",
      "A third tier-1 owner registers after the last standalone syncnodes; sysio.nodes@active lacks it"
    ).push(
      ...planInitialOwner(
        Constants.HandoffNodeOwner,
        Constants.FirstDepositorEthereumHdIndex + Constants.PreSyncNodeOwners.length
      ),
      verifyStep(
        Actor.Sysio,
        "handoff-owner-unsynced",
        `${Constants.HandoffNodeOwner} is on the roster but not on sysio.nodes@active`,
        ctx => assertUnsyncedOwner(ctx, Constants.HandoffNodeOwner),
        StepOptions
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "Handoff",
      "One transaction: syncnodes, then sysio@active and sysio@owner → sysio.nodes@active"
    ).push(
      Governance.planHandoff(
        Actor.Sysio,
        "handoff-to-node-owners",
        "the bootstrap key hands sysio to sysio.nodes@active",
        StepOptions,
        HarnessConstants.NODE_OWNERS_AUTHORITY
      ),
      verifyStep(
        Actor.Sysio,
        "handed-to-node-owners",
        "sysio@active and sysio@owner delegate to sysio.nodes@active",
        ctx => assertHandedTo(ctx, HarnessConstants.NODE_OWNERS_AUTHORITY),
        StepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "handoff-synced-roster",
        `the handoff's syncnodes made sysio.nodes@active the full roster, ${Constants.HandoffNodeOwner} included`,
        assertHandoffSyncedRoster,
        StepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "flow-owners-meet-threshold",
        `the roster is exactly the ${Constants.InitialNodeOwners.length} initial flow owners, at a threshold of ${initialThreshold}`,
        assertFlowOwnersMeetThreshold,
        StepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "audit-after-handoff",
        "the audit is clean and the bootstrap key alone satisfies only the sysio.andon panic permissions",
        (ctx, signal) =>
          auditAuthorities(
            ctx,
            signal,
            AuditPhase.afterHandoff,
            HarnessConstants.NODE_OWNERS_AUTHORITY
          ),
        AuditOptions
      ),
      verifyStep(
        Actor.Sysio,
        "bootstrap-key-refused",
        "a sysio@active action signed by the bootstrap key alone is refused",
        assertBootstrapKeyRefused,
        StepOptions
      )
    )

    // ── 5. The node owners govern by msig ──
    ClusterBuildPhase.create(
      cluster,
      "NodeOwnerMsig",
      "One approval short, a dry-run exec is refused; at the threshold it executes"
    ).push(
      planProposal(
        Constants.NodeOwnersGovernProposal,
        Constants.InitialNodeOwners,
        [probeTransfer(Constants.CouncilMembers[0])],
        `${Proposer} proposes a probe transfer as sysio`
      ),
      ...planApprovals(
        Constants.NodeOwnersGovernProposal,
        Constants.InitialNodeOwners.slice(0, -1)
      ),
      verifyExecutable(
        "refused-one-short",
        Constants.NodeOwnersGovernProposal,
        false,
        "threshold-1 approvals cannot execute"
      ),
      ...planApprovals(
        Constants.NodeOwnersGovernProposal,
        Constants.InitialNodeOwners.slice(-1)
      ),
      planProbeExec(Constants.NodeOwnersGovernProposal),
      verifyProbePaid(Constants.CouncilMembers[0])
    )

    // ── 6. A late owner: the previous roster governs until syncnodes ──
    ClusterBuildPhase.create(
      cluster,
      "LateNodeOwner",
      "A fourth owner claims through BAR.commitNode over OPP after the handoff"
    ).push(
      MintSteps.planMint(
        Actor.User,
        "mint-late-owner",
        `mint ${Constants.LateOwnerMintAmount} tier-1 NFT for ${Constants.LateNodeOwner}'s claim`,
        StepOptions,
        NodeOwnerTier.T1,
        Constants.LateOwnerMintAmount
      ),
      CommitSteps.planApproveEscrow(
        Actor.User,
        "approve-escrow",
        "approve BAR as ERC-1155 operator so commitNode can escrow the unit",
        StepOptions
      ),
      CommitSteps.planCommitNode(
        Actor.User,
        "commit-late-owner",
        `commit the tier-1 node via BAR.commitNode, claiming ${Constants.LateNodeOwner}`,
        StepOptions,
        NodeOwnerTier.T1,
        Constants.LateNodeOwner,
        flowPublicKey(Constants.LateNodeOwner)
      ),
      verifyStep(
        Actor.Sysio,
        "late-owner-registered",
        "the claim reaches the depot over OPP: a tier-1 nodeowners row",
        assertLateOwnerRegistered,
        {
          timeoutMs:
            Constants.LateOwnerDeadlineMs + ProtocolTiming.PollDeadlineBufferMs
        }
      ),
      verifyStep(
        Actor.Sysio,
        "previous-roster-authority",
        "sysio.nodes@active is still the previously synced roster",
        ctx => assertUnsyncedOwner(ctx, Constants.LateNodeOwner),
        StepOptions
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "PreviousRosterGoverns",
      "Until syncnodes, the three initial owners govern and the late owner with two of them does not"
    ).push(
      planProposal(
        Constants.PreviousRosterProposal,
        ownerAccounts,
        [probeTransfer(Constants.CouncilMembers[1])],
        `${Proposer} proposes a probe transfer for the three initial owners to approve`
      ),
      ...planApprovals(Constants.PreviousRosterProposal, Constants.InitialNodeOwners),
      planProposal(
        Constants.LateOwnerProposal,
        ownerAccounts,
        [probeTransfer(Constants.CouncilMembers[2])],
        `${Proposer} proposes a probe transfer for the late owner and two initial owners to approve`
      ),
      ...planApprovals(Constants.LateOwnerProposal, [
        Constants.LateNodeOwner,
        ...Constants.InitialNodeOwners.slice(0, -1)
      ]),
      verifyExecutable(
        "previous-roster-executable",
        Constants.PreviousRosterProposal,
        true,
        "the three initial owners meet the previous roster's threshold"
      ),
      verifyExecutable(
        "refused-late-owner-uncounted",
        Constants.LateOwnerProposal,
        false,
        "the late owner's approval does not count before syncnodes"
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "NewRoster",
      "After syncnodes the late owner's approval counts at the unchanged threshold"
    ).push(
      Steps.contracts.sysio.councl.planSyncnodes(
        Actor.User,
        "resync-nodes",
        `${Constants.LateNodeOwner} syncs sysio.nodes@active to the new roster`,
        StepOptions,
        { caller: Constants.LateNodeOwner }
      ),
      verifyStep(
        Actor.Sysio,
        "new-roster-authority",
        "sysio.nodes@active is exactly the new roster at its threshold",
        assertNodeOwnerAuthorityIsRoster,
        StepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "late-owner-keeps-threshold",
        `the roster is every flow owner, the threshold unchanged: ${initialThreshold} of ${Constants.InitialNodeOwners.length}, now ${rosterThreshold} of ${Constants.NodeOwners.length}`,
        assertLateOwnerKeepsThreshold,
        StepOptions
      ),
      verifyExecutable(
        "late-owner-counts",
        Constants.LateOwnerProposal,
        true,
        "the late owner's approval now counts: with two initial owners it meets the threshold"
      ),
      verifyExecutable(
        "previous-roster-still-governs",
        Constants.PreviousRosterProposal,
        true,
        "the threshold held, so the three initial owners' approvals still meet it"
      ),
      planProbeExec(Constants.LateOwnerProposal),
      verifyProbePaid(Constants.CouncilMembers[2])
    )

    // ── 7. Stand-in council: a stand-in for an election (which needs exactly 21 tier-1 owners) ──
    ClusterBuildPhase.create(
      cluster,
      "StandInCouncil",
      "STAND-IN for an election: the node owners write a small council into sysio.cncl@active"
    ).push(
      planProposal(
        Constants.SetCouncilProposal,
        ownerAccounts,
        [setCouncilAction()],
        `${Proposer} proposes the stand-in council as sysio.cncl@active`
      ),
      ...planApprovals(Constants.SetCouncilProposal, Constants.NodeOwners),
      planProbeExec(Constants.SetCouncilProposal),
      verifyStep(
        Actor.Sysio,
        "council-authority",
        "sysio.cncl@active is the stand-in council at its supermajority",
        assertCouncilAuthority,
        StepOptions
      ),
      planProposal(
        Constants.StaleProposal,
        ownerAccounts,
        [probeTransfer(Constants.CouncilMembers[0])],
        `${Proposer} proposes a probe transfer the node owners approve but never execute`
      ),
      ...planApprovals(Constants.StaleProposal, Constants.NodeOwners)
    )
    ClusterBuildPhase.create(
      cluster,
      "CouncilHandoff",
      "The node owners hand sysio to sysio.cncl@active (sysio@active, then sysio@owner)"
    ).push(
      planProposal(
        Constants.CouncilHandoffProposal,
        ownerAccounts,
        Governance.handoffActions(HarnessConstants.COUNCIL_AUTHORITY),
        `${Proposer} proposes handing sysio to sysio.cncl`
      ),
      ...planApprovals(Constants.CouncilHandoffProposal, Constants.NodeOwners),
      planProbeExec(Constants.CouncilHandoffProposal),
      verifyStep(
        Actor.Sysio,
        "handed-to-council",
        "sysio@active and sysio@owner delegate to sysio.cncl@active",
        ctx => assertHandedTo(ctx, HarnessConstants.COUNCIL_AUTHORITY),
        StepOptions
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "NodeOwnersNoLongerGovern",
      "The node-owner msig governs nothing, before and after another syncnodes (dry runs)"
    ).push(
      verifyExecutable(
        "refused-stale",
        Constants.StaleProposal,
        false,
        "a proposal every node owner approved no longer executes"
      ),
      verifyStep(
        Actor.Sysio,
        "node-owners-cannot-propose",
        "a dry-run propose shows the node owners' approvals cannot authorize a sysio@active action",
        assertNodeOwnersCannotPropose,
        StepOptions
      ),
      Steps.contracts.sysio.councl.planSyncnodes(
        Actor.User,
        "resync-after-council",
        `${Proposer} syncs sysio.nodes@active again`,
        StepOptions,
        { caller: Proposer }
      ),
      verifyStep(
        Actor.Sysio,
        "still-handed-to-council",
        "syncnodes leaves sysio delegated to sysio.cncl@active",
        ctx => assertHandedTo(ctx, HarnessConstants.COUNCIL_AUTHORITY),
        StepOptions
      ),
      verifyExecutable(
        "refused-stale-after-sync",
        Constants.StaleProposal,
        false,
        "after syncnodes the node owners' approved proposal still does not execute"
      ),
      verifyStep(
        Actor.Sysio,
        "node-owners-still-cannot-propose",
        "after syncnodes a dry-run propose by the node owners is still refused",
        assertNodeOwnersCannotPropose,
        StepOptions
      )
    )
    ClusterBuildPhase.create(
      cluster,
      "CouncilGoverns",
      "The stand-in council's supermajority governs sysio"
    ).push(
      planProposal(
        Constants.CouncilGovernsProposal,
        Constants.CouncilMembers,
        [probeTransfer(Constants.CouncilMembers[3])],
        `${Proposer} proposes a probe transfer for the council to approve`
      ),
      ...planApprovals(
        Constants.CouncilGovernsProposal,
        Constants.CouncilMembers.slice(0, councilThreshold - 1)
      ),
      verifyExecutable(
        "refused-council-one-short",
        Constants.CouncilGovernsProposal,
        false,
        "one council approval short, exec is refused"
      ),
      ...planApprovals(
        Constants.CouncilGovernsProposal,
        Constants.CouncilMembers.slice(councilThreshold - 1, councilThreshold)
      ),
      planProbeExec(Constants.CouncilGovernsProposal),
      verifyProbePaid(Constants.CouncilMembers[3]),
      verifyStep(
        Actor.Sysio,
        "audit-after-council",
        "the audit is clean, sysio.cncl@active is the stand-in council, and the bootstrap key still satisfies only the sysio.andon panic permissions",
        (ctx, signal) =>
          auditAuthorities(
            ctx,
            signal,
            AuditPhase.afterHandoff,
            HarnessConstants.COUNCIL_AUTHORITY,
            Constants.CouncilMembers
          ),
        AuditOptions
      )
    )
  }
}
