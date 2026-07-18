import Assert from "node:assert"
import { SysioContracts } from "@wireio/sdk-core"
import {
  ClusterBuildPhase,
  FlowScenario,
  NodeOwnerRegStatus,
  NodeOwnerRejectReason,
  NodeOwnerTier,
  readNodeOwner,
  readNodeOwnerReg,
  Report,
  verifyStep,
  type ClusterBuild,
  type ClusterBuildContext,
  type ClusterBuildOptions
} from "@wireio/cluster-tool"
import { NodeOwnerNftScenarioConstants as Constants } from "./NodeOwnerNftScenarioConstants.js"
import { NodeOwnerNftScenarioMintSteps as MintSteps } from "./steps/NodeOwnerNftScenarioMintSteps.js"
import { NodeOwnerNftScenarioRegistrationSteps as RegistrationSteps } from "./steps/NodeOwnerNftScenarioRegistrationSteps.js"

const { SysioContractName } = SysioContracts
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

/**
 * Hard-abort probe — the depot invariant must REVERT the `sysio.roa::nodeownreg`
 * transaction (no state change), so the typed action invoke is asserted to
 * reject with the chain's abort message. The claim's Wire key is always the dev
 * key (the fixture accounts are created under it); the eth key is the probe's
 * variable (a new EM key for the tier probes, a K1 key for the non-EM probe).
 */
async function assertNodeOwnerRegistrationAborts(
  ctx: ClusterBuildContext,
  ownerAccount: string,
  tier: number,
  ethereumPublicKey: string,
  abortPattern: RegExp
): Promise<void> {
  await Assert.rejects(
    ctx.wire.getSysioContract(SysioContractName.roa).actions.nodeownreg.invoke({
      owner: ownerAccount,
      tier,
      eth_pub_key: ethereumPublicKey,
      wire_pub_key: Constants.DEV_K1_PUBLIC_KEY
    }),
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
 * the `sysio.roa` registration pair the depot inline-sends when an inbound OPP
 * NodeOwnerRegistration decodes (`newnameduser` then `nodeownreg`), driven
 * directly and exercising every outcome of the retired jest flow:
 *
 * 1. **HappyPath** — create + register → `nodeowners` row + CONFIRMED audit.
 * 2. **WrongKey** — existing account, different Wire key → REJECTED/ACCOUNT_KEY_MISMATCH.
 * 3. **NameInvalid** — tier-1 name over the 2-6 char prefix budget → REJECTED/NAME_INVALID.
 * 4. **OwnerNotAccount** — valid-for-tier name never created → REJECTED/OWNER_NOT_ACCOUNT.
 * 5. **Duplicate** — replay for a confirmed owner → REJECTED/DUPLICATE.
 * 6. **HardAborts** — tier 0 / tier 4 and a non-EM (K1) eth key REVERT the tx
 *    (depot/system invariants — asserted via `Assert.rejects`, not scenario failures).
 * 7. **MockNodesMint** — MockWireNodes accepts a tier-1 mint at 1 ether; the
 *    `TransferSingle`-observed supply bumps and the minter's balance reflects it.
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
      RegistrationSteps.planCreateNamedUser(
        Actor.User,
        "create-happy-owner",
        `create ${Constants.HappyPathAccount} under the dev key`,
        stepOptions,
        Constants.HappyPathAccount,
        Constants.DEV_K1_PUBLIC_KEY,
        NodeOwnerTier.T1
      ),
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
      "Claim for an existing account controlled by a different key → REJECTED/ACCOUNT_KEY_MISMATCH"
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
        "no nodeowners row; audit REJECTED/ACCOUNT_KEY_MISMATCH",
        ctx =>
          assertRejectedWithoutRow(
            ctx,
            Constants.WrongKeyAccount,
            NodeOwnerRejectReason.AccountKeyMismatch
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

    // ── 4. Valid-for-tier name that was never created → soft-fail ──
    ClusterBuildPhase.create(
      cluster,
      "OwnerNotAccount",
      "Valid-for-tier name that was never created → REJECTED/OWNER_NOT_ACCOUNT"
    ).push(
      RegistrationSteps.planRegisterNodeOwner(
        Actor.User,
        "register-ghost-owner",
        `claim the never-created account ${Constants.GhostAccount} at tier 1`,
        stepOptions,
        Constants.GhostAccount,
        NodeOwnerTier.T1,
        Constants.GhostEthereumHdIndex,
        Constants.DEV_K1_PUBLIC_KEY
      ),
      verifyStep(
        Actor.Sysio,
        "rejected-ghost-owner",
        "no nodeowners row; audit REJECTED/OWNER_NOT_ACCOUNT",
        ctx =>
          assertRejectedWithoutRow(
            ctx,
            Constants.GhostAccount,
            NodeOwnerRejectReason.OwnerNotAccount
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
      RegistrationSteps.planCreateNamedUser(
        Actor.User,
        "create-duplicate-owner",
        `create ${Constants.DuplicateAccount} under the dev key`,
        stepOptions,
        Constants.DuplicateAccount,
        Constants.DEV_K1_PUBLIC_KEY,
        NodeOwnerTier.T1
      ),
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
        "audit REJECTED/DUPLICATE after the replay",
        ctx =>
          assertRejectedAudit(
            ctx,
            Constants.DuplicateAccount,
            NodeOwnerRejectReason.Duplicate
          ),
        stepOptions
      )
    )

    // ── 6. Depot/system invariants → hard abort (the tx REVERTS) ──
    ClusterBuildPhase.create(
      cluster,
      "HardAborts",
      "Tier out of [1,3] and a non-EM eth key REVERT the registration tx"
    ).push(
      RegistrationSteps.planCreateNamedUser(
        Actor.User,
        "create-invalid-tier-owner",
        `create ${Constants.InvalidTierAccount} under the dev key`,
        stepOptions,
        Constants.InvalidTierAccount,
        Constants.DEV_K1_PUBLIC_KEY,
        NodeOwnerTier.T1
      ),
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
      RegistrationSteps.planCreateNamedUser(
        Actor.User,
        "create-non-em-key-owner",
        `create ${Constants.NonEmKeyAccount} under the dev key`,
        stepOptions,
        Constants.NonEmKeyAccount,
        Constants.DEV_K1_PUBLIC_KEY,
        NodeOwnerTier.T1
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
  }
}
