import Assert from "node:assert"
import {
  getCompressedPublicKey,
  KeyType,
  PublicKey,
  SysioContracts
} from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  FlowScenario,
  matchesProtoEnum,
  NodeOwnerRegStatus,
  NodeOwnerRejectReason,
  NodeOwnerTier,
  pollUntil,
  ProtocolTiming,
  readNodeOwner,
  readNodeOwnerReg,
  Report,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { NodeOwnerNftScenarioConstants as Constants } from "./NodeOwnerNftScenarioConstants.js"
import { NodeOwnerNftScenarioCommitSteps as CommitSteps } from "./steps/NodeOwnerNftScenarioCommitSteps.js"
import { NodeOwnerNftScenarioMintSteps as MintSteps } from "./steps/NodeOwnerNftScenarioMintSteps.js"
import { NodeOwnerNftScenarioRegistrationSteps as RegistrationSteps } from "./steps/NodeOwnerNftScenarioRegistrationSteps.js"

const { SysioAuthexChainkind, SysioContractName } = SysioContracts
const { Actor } = Report

/** The owner's `nodeownerreg` audit row must be REJECTED with `reason` (reads). */
async function assertRejectedAudit(
  ctx: ClusterBuildContext,
  account: string,
  reason: NodeOwnerRejectReason
): Promise<void> {
  const audit = await readNodeOwnerReg(ctx.wire, account)
  Assert.strictEqual(
    Number(audit?.status),
    NodeOwnerRegStatus.Rejected,
    `audit status must be REJECTED for ${account}`
  )
  Assert.strictEqual(
    Number(audit?.reason),
    reason,
    `audit reason must be ${NodeOwnerRejectReason[reason]} for ${account}`
  )
}

/** Soft-fail verify — no `nodeowners` row for `account`, plus {@link assertRejectedAudit}. */
async function assertRejectedWithoutRow(
  ctx: ClusterBuildContext,
  account: string,
  reason: NodeOwnerRejectReason
): Promise<void> {
  Assert.ok(
    (await readNodeOwner(ctx.wire, account)) == null,
    `nodeowners row must be absent for ${account}`
  )
  await assertRejectedAudit(ctx, account, reason)
}

/** Compare Ethereum identities in compressed SEC1 form, regardless of RPC encoding. */
function compressedEthereumKey(value: string): string {
  const key = PublicKey.from(value)
  Assert.strictEqual(
    key.type,
    KeyType.EM,
    "AuthEx Ethereum link must contain an EM key"
  )
  return getCompressedPublicKey(key.data.hexString, KeyType.EM)
}

/** Verify that the original Ethereum identity survived and the rejected key was not linked. */
async function assertPreservedEthereumLink(
  ctx: ClusterBuildContext,
  account: string,
  linkedHdIndex: number,
  rejectedHdIndex: number
): Promise<void> {
  const linkedKey = await RegistrationSteps.newEthereumPublicKey(
      ctx,
      linkedHdIndex
    ),
    rejectedKey = await RegistrationSteps.newEthereumPublicKey(
      ctx,
      rejectedHdIndex
    ),
    links = await ctx.wire
      .getSysioContract(SysioContractName.authex)
      .tables.links.queryAll(),
    ethereumLinks = links
      .filter(row =>
        matchesProtoEnum(
          row.chain_kind,
          SysioAuthexChainkind,
          SysioAuthexChainkind.CHAIN_KIND_EVM
        )
      )
      .map(row => ({
        username: row.username,
        key: compressedEthereumKey(row.pub_key)
      }))
  Assert.deepStrictEqual(
    ethereumLinks.filter(row => row.username === account).map(row => row.key),
    [compressedEthereumKey(linkedKey)],
    `original Ethereum link must be preserved for ${account}`
  )
  const rejectedPoint = compressedEthereumKey(rejectedKey)
  Assert.ok(
    !ethereumLinks.some(row => row.key === rejectedPoint),
    `rejected depositor key must remain unlinked for ${account}`
  )
}

async function verifyExistingAccountRejected(
  ctx: ClusterBuildContext,
  account: string,
  linkedHdIndex: number,
  rejectedHdIndex: number
): Promise<void> {
  await assertRejectedWithoutRow(ctx, account, NodeOwnerRejectReason.AccountExists)
  await assertPreservedEthereumLink(ctx, account, linkedHdIndex, rejectedHdIndex)
}

async function verifyDuplicateRejected(ctx: ClusterBuildContext): Promise<void> {
  const account = Constants.DuplicateAccount,
    registration = await readNodeOwner(ctx.wire, account)
  await assertRejectedAudit(ctx, account, NodeOwnerRejectReason.Duplicate)
  Assert.strictEqual(
    Number(registration?.tier),
    NodeOwnerTier.T1,
    `original Tier-1 membership must be preserved for ${account}`
  )
  await assertPreservedEthereumLink(
    ctx,
    account,
    Constants.DuplicateEthereumHdIndex,
    Constants.DuplicateReplayEthereumHdIndex
  )
}

/**
 * Hard-abort probe — the depot invariant must REVERT the `sysio.roa::nodeownreg`
 * transaction (no state change), so the typed action invoke is asserted to
 * reject with the chain's abort message. The claim's Wire key is always the dev
 * key (accepted claims create the account under it); the eth key is the probe's
 * variable (a new EM key for the tier probes, a K1 key for the non-EM probe).
 */
async function assertNodeOwnerRegistrationAborts(
  ctx: ClusterBuildContext,
  ownerAccount: string,
  tier: number,
  ethereumPublicKey: string,
  abortPattern: RegExp
): Promise<void> {
  const registration: SysioContracts.SysioRoaNodeownregAction = {
    owner: ownerAccount,
    tier,
    eth_pub_key: ethereumPublicKey,
    wire_pub_key: Constants.DEV_K1_PUBLIC_KEY,
    eth_address: "00".repeat(20)
  }
  await Assert.rejects(
    ctx.wire
      .getSysioContract(SysioContractName.roa)
      .actions.nodeownreg.invoke(registration),
    abortPattern
  )
}

/** HappyPath verify — `nodeowners` row at tier 1 + CONFIRMED audit (reads). */
async function verifyHappyPathConfirmed(
  ctx: ClusterBuildContext
): Promise<void> {
  const registration = await readNodeOwner(ctx.wire, Constants.HappyPathAccount)
  Assert.ok(
    registration != null,
    `missing nodeowners row for ${Constants.HappyPathAccount}`
  )
  Assert.strictEqual(
    Number(registration.tier),
    NodeOwnerTier.T1,
    "registered tier must be T1"
  )
  const audit = await readNodeOwnerReg(ctx.wire, Constants.HappyPathAccount)
  Assert.strictEqual(
    Number(audit?.status),
    NodeOwnerRegStatus.Confirmed,
    "audit status must be CONFIRMED"
  )
}

/**
 * Commit-path verify — the `nodeowners` row lands via the REAL OPP hop
 * (`BAR.commitNode` → outbound envelope → depot dispatch → inline
 * `nodeownreg`), then the audit reads CONFIRMED. The poll
 * budget is the single-hop envelope; the row appears as soon as the depot
 * processes the consensus envelope carrying the attestation.
 */
async function verifyCommitPathConfirmed(
  ctx: ClusterBuildContext
): Promise<void> {
  await pollUntil(
    `nodeowners row for ${Constants.CommitPathAccount} via OPP`,
    async () =>
      (await readNodeOwner(ctx.wire, Constants.CommitPathAccount)) != null,
    Constants.CommitPathDeadlineMs,
    Constants.CommitPathPollIntervalMs
  )
  const registration = await readNodeOwner(ctx.wire, Constants.CommitPathAccount)
  Assert.strictEqual(
    Number(registration.tier),
    NodeOwnerTier.T1,
    "commit-path registered tier must be T1"
  )
  const audit = await readNodeOwnerReg(ctx.wire, Constants.CommitPathAccount)
  Assert.strictEqual(
    Number(audit?.status),
    NodeOwnerRegStatus.Confirmed,
    "commit-path audit status must be CONFIRMED"
  )
}

/** Mint snapshot — record the pre-mint tier-1 `viewTotalSupply` into `ctx.outputs` (a read checkpoint). */
async function snapshotTotalSupplyBefore(
  ctx: ClusterBuildContext
): Promise<void> {
  const contract = MintSteps.resolveMockWireNodes(ctx)
  ctx.outputs.set(
    MintSteps.TotalSupplyBeforeKey,
    await contract.viewTotalSupply(NodeOwnerTier.T1)
  )
}

/** Mint verify — `viewTotalSupply` bumped by exactly the mint; the minter holds ≥ 1 (reads). */
async function verifyMintSupplyAndBalance(
  ctx: ClusterBuildContext
): Promise<void> {
  const contract = MintSteps.resolveMockWireNodes(ctx),
    totalSupplyBefore = ctx.outputs.assert(MintSteps.TotalSupplyBeforeKey),
    totalSupplyAfter = await contract.viewTotalSupply(NodeOwnerTier.T1)
  Assert.strictEqual(
    totalSupplyAfter - totalSupplyBefore,
    Constants.ExpectedSupplyDelta,
    "totalSupply must bump by the minted amount"
  )
  const minterBalance = await contract.balanceOf(
    ctx.ethereum.wallet.address,
    NodeOwnerTier.T1
  )
  Assert.ok(
    minterBalance >= Constants.MinimumMinterBalance,
    `minter balance must be >= ${Constants.MinimumMinterBalance}`
  )
}

/**
 * Node owner NFT registration (create-in-flow) — ERC-1155 mint observation +
 * the `sysio.roa::nodeownreg` action the depot inline-sends when an inbound OPP
 * NodeOwnerRegistration decodes, driven
 * directly and exercising every outcome of the retired jest flow:
 *
 * 1. **HappyPath** — create + register → `nodeowners` row + CONFIRMED audit.
 * 2. **WrongKey** — existing account, different Wire key → REJECTED/ACCOUNT_EXISTS.
 * 3. **NameInvalid** — tier-1 name over the 2-6 char prefix budget → REJECTED/NAME_INVALID.
 * 4. **ExistingAccount** — matching public active key still rejects → REJECTED/ACCOUNT_EXISTS.
 * 5. **Duplicate** — replay for a confirmed owner → REJECTED/DUPLICATE.
 * 6. **HardAborts** — tier 0 / tier 4 and a non-EM (K1) eth key REVERT the tx
 *    (depot/system invariants — asserted via `Assert.rejects`, not scenario failures).
 * 7. **MockNodesMint** — MockWireNodes accepts a tier-1 mint at 1 ether; the
 *    `TransferSingle`-observed supply bumps and the minter's balance reflects it.
 * 8. **CommitNodePath** — the PRODUCTION path end-to-end: mint, approve BAR
 *    as ERC-1155 operator, then `BAR.commitNode` escrows the unit in BAR and
 *    emits the full NodeOwnerRegistration via OPP; the depot dispatches it
 *    and the `nodeowners` row + CONFIRMED audit land on WIRE.
 *
 * Claim-payload problems (2-5) soft-fail into a `nodeownerreg` audit row rather
 * than throwing (trust-OPP); only the depot/system invariants (6) hard-abort.
 */
export class NodeOwnerNftScenario extends FlowScenario {
  readonly name = "flow-node-owner-nft"
  readonly description =
    "ERC-1155 mint + sysio.roa create-in-flow node-owner registration: CONFIRMED happy path, per-reason soft-fail audits, depot hard-aborts"

  override readonly defaults: ClusterBuildOptions = {
    epochDurationSec: Constants.EpochDurationSec,
    producerCount: Constants.ProducerCount,
    batchOperatorCount: Constants.BatchOperatorCount,
    underwriterCount: Constants.UnderwriterCount
  }

  plan(cluster: ClusterBuild): void {
    const stepOptions = { timeoutMs: Constants.StepTimeoutMs }

    // ── 1. Happy path — create with the holder's key, register, CONFIRMED ──
    ClusterBuildPhase.create(
      cluster,
      "HappyPath",
      "Create + register a tier-1 owner → nodeowners row + CONFIRMED audit"
    ).push(
      RegistrationSteps.planRegisterNodeOwner(
        Actor.User,
        "register-happy-owner",
        `register ${Constants.HappyPathAccount} at tier 1`,
        stepOptions,
        Constants.HappyPathAccount,
        NodeOwnerTier.T1,
        Constants.HappyPathEthereumHdIndex,
        Constants.DEV_K1_PUBLIC_KEY
      ),
      verifyStep(
        Actor.Sysio,
        "confirmed-happy-owner",
        "nodeowners row exists at tier 1; audit status CONFIRMED",
        verifyHappyPathConfirmed,
        stepOptions
      )
    )

    // ── 2. Existing account controlled by a different key → soft-fail ──
    ClusterBuildPhase.create(
      cluster,
      "WrongKey",
      "Claim for an existing account controlled by a different key → REJECTED/ACCOUNT_EXISTS"
    ).push(
      RegistrationSteps.planCreateNamedUser(
        Actor.User,
        "create-wrong-key-owner",
        `create ${Constants.WrongKeyAccount} under the dev key`,
        stepOptions,
        Constants.WrongKeyAccount,
        Constants.DEV_K1_PUBLIC_KEY,
        NodeOwnerTier.T1
      ),
      RegistrationSteps.planAuthexLink(
        Actor.Sysio,
        "link-wrong-key-owner",
        `record ${Constants.WrongKeyAccount}'s existing Ethereum link`,
        stepOptions,
        Constants.WrongKeyAccount,
        Constants.WrongKeyLinkedEthereumHdIndex
      ),
      RegistrationSteps.planRegisterNodeOwner(
        Actor.User,
        "register-wrong-key-owner",
        `claim ${Constants.WrongKeyAccount} with a Wire key it is NOT controlled by`,
        stepOptions,
        Constants.WrongKeyAccount,
        NodeOwnerTier.T1,
        Constants.WrongKeyEthereumHdIndex,
        Constants.OtherWireKey
      ),
      verifyStep(
        Actor.Sysio,
        "rejected-wrong-key-owner",
        "no nodeowners row; audit REJECTED/ACCOUNT_EXISTS; original Ethereum link preserved",
        ctx =>
          verifyExistingAccountRejected(
            ctx,
            Constants.WrongKeyAccount,
            Constants.WrongKeyLinkedEthereumHdIndex,
            Constants.WrongKeyEthereumHdIndex
          ),
        stepOptions
      )
    )

    // ── 3. Name invalid for tier (tier-1 names are a 2-6 char prefix) → soft-fail ──
    ClusterBuildPhase.create(
      cluster,
      "NameInvalid",
      "Tier-1 name over the 2-6 char prefix budget → REJECTED/NAME_INVALID"
    ).push(
      RegistrationSteps.planRegisterNodeOwner(
        Actor.User,
        "register-name-invalid-owner",
        `claim the 11-char name ${Constants.NameInvalidAccount} at tier 1`,
        stepOptions,
        Constants.NameInvalidAccount,
        NodeOwnerTier.T1,
        Constants.NameInvalidEthereumHdIndex,
        Constants.DEV_K1_PUBLIC_KEY
      ),
      verifyStep(
        Actor.Sysio,
        "rejected-name-invalid-owner",
        "no nodeowners row; audit REJECTED/NAME_INVALID",
        ctx =>
          assertRejectedWithoutRow(
            ctx,
            Constants.NameInvalidAccount,
            NodeOwnerRejectReason.NameInvalid
          ),
        stepOptions
      )
    )

    // ── 4. Copying an existing account's public key does not authorize a claim ──
    ClusterBuildPhase.create(
      cluster,
      "ExistingAccount",
      "Existing account with matching public key → REJECTED/ACCOUNT_EXISTS"
    ).push(
      RegistrationSteps.planCreateNamedUser(
        Actor.User,
        "create-existing-owner",
        `create ${Constants.ExistingAccount} before the claim`,
        stepOptions,
        Constants.ExistingAccount,
        Constants.DEV_K1_PUBLIC_KEY,
        NodeOwnerTier.T1
      ),
      RegistrationSteps.planAuthexLink(
        Actor.Sysio,
        "link-existing-owner",
        `record ${Constants.ExistingAccount}'s existing Ethereum link`,
        stepOptions,
        Constants.ExistingAccount,
        Constants.ExistingLinkedEthereumHdIndex
      ),
      RegistrationSteps.planRegisterNodeOwner(
        Actor.User,
        "reject-existing-owner",
        `claim ${Constants.ExistingAccount} with its public active key`,
        stepOptions,
        Constants.ExistingAccount,
        NodeOwnerTier.T1,
        Constants.ExistingEthereumHdIndex,
        Constants.DEV_K1_PUBLIC_KEY
      ),
      verifyStep(
        Actor.Sysio,
        "rejected-existing-owner",
        "no nodeowners row; audit REJECTED/ACCOUNT_EXISTS; original Ethereum link preserved",
        ctx =>
          verifyExistingAccountRejected(
            ctx,
            Constants.ExistingAccount,
            Constants.ExistingLinkedEthereumHdIndex,
            Constants.ExistingEthereumHdIndex
          ),
        stepOptions
      )
    )

    // ── 5. Replay for a confirmed owner → soft-fail DUPLICATE ──
    ClusterBuildPhase.create(
      cluster,
      "Duplicate",
      "A second registration for the same owner → REJECTED/DUPLICATE"
    ).push(
      RegistrationSteps.planRegisterNodeOwner(
        Actor.User,
        "register-duplicate-first",
        `register ${Constants.DuplicateAccount} at tier 1 (confirms)`,
        stepOptions,
        Constants.DuplicateAccount,
        NodeOwnerTier.T1,
        Constants.DuplicateEthereumHdIndex,
        Constants.DEV_K1_PUBLIC_KEY
      ),
      RegistrationSteps.planRegisterNodeOwner(
        Actor.User,
        "register-duplicate-replay",
        `replay ${Constants.DuplicateAccount} at tier 2 with a new eth key`,
        stepOptions,
        Constants.DuplicateAccount,
        Constants.DuplicateReplayTier,
        Constants.DuplicateReplayEthereumHdIndex,
        Constants.DEV_K1_PUBLIC_KEY
      ),
      verifyStep(
        Actor.Sysio,
        "rejected-duplicate-owner",
        "audit REJECTED/DUPLICATE; original Tier-1 membership and Ethereum link preserved",
        verifyDuplicateRejected,
        stepOptions
      )
    )

    // ── 6. Depot/system invariants → hard abort (the tx REVERTS) ──
    ClusterBuildPhase.create(
      cluster,
      "HardAborts",
      "Tier out of [1,3] and a non-EM eth key REVERT the registration tx"
    ).push(
      verifyStep(
        Actor.Sysio,
        "hard-abort-tier-below-minimum",
        `tier ${Constants.TierBelowMinimum} registration reverts`,
        async ctx =>
          assertNodeOwnerRegistrationAborts(
            ctx,
            Constants.InvalidTierAccount,
            Constants.TierBelowMinimum,
            await RegistrationSteps.newEthereumPublicKey(
              ctx,
              Constants.TierBelowMinimumEthereumHdIndex
            ),
            Constants.InvalidTierAbortPattern
          ),
        stepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "hard-abort-tier-above-maximum",
        `tier ${Constants.TierAboveMaximum} registration reverts`,
        async ctx =>
          assertNodeOwnerRegistrationAborts(
            ctx,
            Constants.InvalidTierAccount,
            Constants.TierAboveMaximum,
            await RegistrationSteps.newEthereumPublicKey(
              ctx,
              Constants.TierAboveMaximumEthereumHdIndex
            ),
            Constants.InvalidTierAbortPattern
          ),
        stepOptions
      ),
      verifyStep(
        Actor.Sysio,
        "hard-abort-non-em-key",
        "a K1 key where an EM (secp256k1) key is required reverts",
        ctx =>
          assertNodeOwnerRegistrationAborts(
            ctx,
            Constants.NonEmKeyAccount,
            NodeOwnerTier.T1,
            Constants.DEV_K1_PUBLIC_KEY,
            Constants.NonEmKeyAbortPattern
          ),
        stepOptions
      )
    )

    // ── 7. MockWireNodes sanity — the ERC-1155 surface the production flow observes ──
    ClusterBuildPhase.create(
      cluster,
      "MockNodesMint",
      "MockWireNodes accepts a tier-1 mint at 1 ether; totalSupply bumps"
    ).push(
      verifyStep(
        Actor.EthereumOutpost,
        "snapshot-total-supply",
        "record the tier-1 totalSupply before the mint",
        snapshotTotalSupplyBefore,
        stepOptions
      ),
      MintSteps.planMint(
        Actor.User,
        "mint-tier-one",
        `mint ${Constants.MintAmount} tier-1 NFT at 1 ether`,
        stepOptions,
        NodeOwnerTier.T1,
        Constants.MintAmount
      ),
      verifyStep(
        Actor.EthereumOutpost,
        "supply-and-balance",
        "totalSupply bumped by the mint; minter balance reflects it",
        verifyMintSupplyAndBalance,
        stepOptions
      )
    )

    // ── 8. The PRODUCTION path — BAR.commitNode → OPP → depot dispatch ──
    ClusterBuildPhase.create(
      cluster,
      "CommitNodePath",
      "BAR.commitNode emits the full NodeOwnerRegistration via OPP → nodeowners row + CONFIRMED audit"
    ).push(
      MintSteps.planMint(
        Actor.User,
        "mint-commit-path",
        `mint ${Constants.MintAmount} tier-1 NFT for the commit-path claim`,
        stepOptions,
        NodeOwnerTier.T1,
        Constants.MintAmount
      ),
      CommitSteps.planApproveEscrow(
        Actor.User,
        "approve-escrow",
        "approve BAR as ERC-1155 operator so commitNode can escrow the committed unit",
        stepOptions
      ),
      CommitSteps.planCommitNode(
        Actor.User,
        "commit-node",
        `commit the tier-1 node via BAR.commitNode, claiming ${Constants.CommitPathAccount}`,
        stepOptions,
        NodeOwnerTier.T1,
        Constants.CommitPathAccount,
        Constants.DEV_K1_PUBLIC_KEY
      ),
      verifyStep(
        Actor.Sysio,
        "confirmed-commit-path",
        "nodeowners row lands via the OPP hop; audit status CONFIRMED",
        verifyCommitPathConfirmed,
        { timeoutMs: Constants.CommitPathDeadlineMs + ProtocolTiming.PollDeadlineBufferMs }
      )
    )
  }
}
