import { Constants, NodeOwnerTier, ProtocolTiming } from "@wireio/cluster-tool"

/**
 * Constants for the node-owner NFT flow. Account names, the wrong-key fixture,
 * tier bounds, and the hard-abort patterns carry over from the
 * previously-validated jest flow (tests/NodeOwnerNFT.test.ts, 2026-06): every
 * registration outcome keeps its original owner account so the `nodeownerreg`
 * audit reads stay per-owner, and every claim derives a distinct depositor EM
 * key from its own anvil-mnemonic HD index.
 */
export namespace NodeOwnerNftScenarioConstants {
  /** Epoch duration (s) — the `sysio.epoch::setconfig` floor is 60. */
  export const EpochDurationSec = 60

  /** Producer nodes stood up by the bootstrap (from the validated flow run). */
  export const ProducerCount = 3
  /** Bootstrapped batch operators stood up by the bootstrap. */
  export const BatchOperatorCount = 3
  /** Bootstrapped underwriters stood up by the bootstrap. */
  export const UnderwriterCount = 1

  /** The dev K1 key each fixture owner account is created under (controls `owner@active`). */
  export const DEV_K1_PUBLIC_KEY = Constants.DEV_K1_PUBLIC_KEY

  /**
   * A second, distinct Wire K1 key (from `clio create key --k1`) — the
   * wrong-key claim names it while the account is NOT controlled by it.
   */
  export const OtherWireKey = "PUB_K1_84yPGCSNRdSTrdpYnfzWun477PzuKR4L4R8eYumxqLjoG8s2Jo"

  /** Happy-path owner — created under the dev key, registers CONFIRMED at tier 1. */
  export const HappyPathAccount = "nfta"
  /** Wrong-key owner — exists under the dev key; the claim carries {@link OtherWireKey}. */
  export const WrongKeyAccount = "nftb"
  /** 11-char name — valid charset, over the tier-1 2-6 char prefix budget. */
  export const NameInvalidAccount = "toolongname"
  /** Valid-for-tier-1 name (5 chars) that is never created on chain. */
  export const GhostAccount = "ghost"
  /** Replay owner — registered CONFIRMED, then re-registered → DUPLICATE. */
  export const DuplicateAccount = "nftd"
  /** Hard-abort owner for the tier-out-of-[1,3] invariant. */
  export const InvalidTierAccount = "nfte"
  /** Hard-abort owner for the non-EM (K1) eth-key invariant. */
  export const NonEmKeyAccount = "nftf"
  /** Commit-path owner — claimed via `BAR.commitNode` on the outpost, registered through OPP. */
  export const CommitPathAccount = "nftg"

  /** Tier below the depot's [1,3] window → hard abort. */
  export const TierBelowMinimum = 0
  /** Tier above the depot's [1,3] window → hard abort. */
  export const TierAboveMaximum = 4
  /** Replay tier for the DUPLICATE case (differs from the first registration's tier 1). */
  export const DuplicateReplayTier = NodeOwnerTier.T2

  /** Depot abort message for a tier outside [1,3]. */
  export const InvalidTierAbortPattern = /Tier level must be between 1 and 3/
  /** Depot abort message for a non-EM eth key. */
  export const NonEmKeyAbortPattern = /EM \(secp256k1\) public key/

  /** Anvil-mnemonic HD index for the happy-path claim's depositor EM key (past every bootstrap slot). */
  export const HappyPathEthereumHdIndex = 40
  /** HD index for the wrong-key claim's depositor EM key. */
  export const WrongKeyEthereumHdIndex = 41
  /** HD index for the name-invalid claim's depositor EM key. */
  export const NameInvalidEthereumHdIndex = 42
  /** HD index for the ghost-owner claim's depositor EM key. */
  export const GhostEthereumHdIndex = 43
  /** HD index for the duplicate owner's FIRST (confirmed) claim. */
  export const DuplicateEthereumHdIndex = 44
  /** HD index for the duplicate owner's REPLAY claim (a new key, like the original flow). */
  export const DuplicateReplayEthereumHdIndex = 45
  /** HD index for the tier-below-minimum hard-abort probe's EM key. */
  export const TierBelowMinimumEthereumHdIndex = 46
  /** HD index for the tier-above-maximum hard-abort probe's EM key. */
  export const TierAboveMaximumEthereumHdIndex = 47

  /** ERC-1155 units minted from MockWireNodes (the contract charges `1 ether` per unit). */
  export const MintAmount = 1
  /** Expected `viewTotalSupply` delta after the mint. */
  export const ExpectedSupplyDelta = 1n
  /** Minimum `balanceOf(minter, tier)` after the mint. */
  export const MinimumMinterBalance = 1n

  /** Hard ceiling per write / verify step (finality waits + hard-abort push retries). */
  export const StepTimeoutMs = 120_000

  /**
   * Outpost-act → depot-verify deadline for the commit-path claim: the
   * NODE_OWNER_REG attestation rides the next outbound OPP envelope (one hop).
   */
  export const CommitPathDeadlineMs = ProtocolTiming.SingleHopBudgetMs
  /** Poll gap while waiting for the commit-path depot rows. */
  export const CommitPathPollIntervalMs = 5_000
  /** Ceiling margin the commit-path verify step carries above its inner poll deadline. */
  export const PollDeadlineBufferMs = 30_000
}
