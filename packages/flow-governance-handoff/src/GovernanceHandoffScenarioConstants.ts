import { Constants, formatWireAsset, ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the governance-handoff flow: the identities it controls, the
 * proposals it raises, and the probe transfer each executed proposal pays.
 */
export namespace GovernanceHandoffScenarioConstants {
  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60
  /** Producer nodes stood up by the bootstrap. */
  export const ProducerCount = 3
  /** Bootstrapped batch operators stood up by the bootstrap (they carry the late owner's OPP claim). */
  export const BatchOperatorCount = 3
  /** Bootstrapped underwriters stood up by the bootstrap. */
  export const UnderwriterCount = 0

  /** The initial tier-1 owners registered before the standalone `syncnodes`. */
  export const PreSyncNodeOwners = ["gova", "govb"] as const
  /**
   * The initial tier-1 owner registered AFTER the last standalone `syncnodes`:
   * only the `syncnodes` inside the handoff transaction can put it on
   * `sysio.nodes@active`, which makes that `syncnodes` observable.
   */
  export const HandoffNodeOwner = "govc"
  /**
   * The tier-1 owners the flow registers before the handoff, under keys it
   * controls. The bootstrap registers no tier-1 owner, so these three are the
   * whole roster after the handoff, at its threshold of three (3 of 3): they
   * alone govern `sysio`, and two of them are exactly one approval short. The
   * flow checks the roster on chain before relying on it.
   */
  export const InitialNodeOwners = [...PreSyncNodeOwners, HandoffNodeOwner] as const
  /**
   * The tier-1 owner who claims AFTER the handoff, through the production NFT
   * path over OPP. It takes the roster to four owners and leaves the threshold
   * at three (3 of 4).
   */
  export const LateNodeOwner = "govd"
  /** Every tier-1 owner the flow controls, in the order they approve. */
  export const NodeOwners = [...InitialNodeOwners, LateNodeOwner] as const
  /**
   * The stand-in council `sysio` is finally handed to — stand-ins for the 21
   * seats of a real election, which needs exactly 21 tier-1 owners and is out of
   * this flow's scope. Four members make a threshold of three.
   */
  export const CouncilMembers = ["cnla", "cnlb", "cnlc", "cnld"] as const
  /** Every identity the flow controls: each holds a WIRE key of its own, none of them the bootstrap key. */
  export const Identities = [...NodeOwners, ...CouncilMembers] as const

  /** The prefix of every flow identity's durable handle. */
  export const IdentityHandlePrefix = "governance-handoff-"

  /**
   * The durable handle of a flow identity: its random WIRE key, and an initial
   * owner's depositor wallet, are persisted under it in the cluster data
   * directory.
   *
   * @param account - The identity's account.
   * @returns The handle.
   */
  export function identityHandle(account: string): string {
    return `${IdentityHandlePrefix}${account}`
  }

  /** ERC-1155 units the late owner mints and commits (the contract charges `1 ether` per unit). */
  export const LateOwnerMintAmount = 1

  /** WIRE base units each executed probe proposal pays its recipient. */
  export const ProbeTransferUnits = 10n ** BigInt(Constants.WIRE_PRECISION)
  /** {@link ProbeTransferUnits} as an asset. */
  export const ProbeTransferQuantity = formatWireAsset(ProbeTransferUnits)
  /** The memo every probe transfer carries. */
  export const ProbeTransferMemo = "governance handoff probe"

  /** Proposal: the node owners govern `sysio` right after the handoff (pays `cnla`). */
  export const NodeOwnersGovernProposal = "nodesgovern"
  /**
   * Proposal approved by the three initial owners after the late owner
   * registers: executable under the previous roster, and still executable
   * after `syncnodes` because the threshold holds at three. Never executed
   * (would pay `cnlb`).
   */
  export const PreviousRosterProposal = "oldroster"
  /**
   * Proposal approved by the late owner and two initial owners: refused under
   * the previous roster, which does not count the late owner; executable after
   * `syncnodes`, which does. Executed then (pays `cnlc`).
   */
  export const LateOwnerProposal = "lateowner"
  /** Proposal: write the stand-in council into `sysio.cncl@active`. */
  export const SetCouncilProposal = "setcouncil"
  /** Proposal: hand `sysio` to `sysio.cncl`. */
  export const CouncilHandoffProposal = "tocouncil"
  /** Proposal approved by the node owners BEFORE the council handoff and never executed. */
  export const StaleProposal = "stale"
  /** Proposal the node owners can no longer even propose after the council handoff (a dry run only). */
  export const RefusedProposal = "nodesrefused"
  /** Proposal: the stand-in council governs `sysio` (pays `cnld`). */
  export const CouncilGovernsProposal = "council"

  /** Seconds the bootstrap-key probe transaction stays valid. */
  export const SignedProbeExpirationSec = 60
  /** The chain's refusal of a transaction whose signatures do not satisfy its declared authority. */
  export const UnsatisfiedAuthorizationPattern =
    /unsatisfied_authorization|does not have signatures|3090003/

  /** Hard ceiling per write / verify step (finality waits + push retries). */
  export const StepTimeoutMs = 120_000
  /** Ceiling of an authority audit, which scans the chain's whole trace history. */
  export const AuditTimeoutMs = 600_000
  /** Outpost-act → depot-verify deadline for the late owner's claim (one OPP hop). */
  export const LateOwnerDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /** Poll gap while waiting for the late owner's depot rows. */
  export const LateOwnerPollIntervalMs = 5_000
}
