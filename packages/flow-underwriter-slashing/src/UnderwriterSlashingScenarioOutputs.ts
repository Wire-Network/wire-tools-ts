import { outputKey, type OutputKey } from "@wireio/cluster-tool"

/**
 * Typed cross-step output keys for the underwriter-slashing flow. Each swap's
 * quote step snapshots its target amount; each capture step records the
 * CONFIRMED commitment (uwreq id + winning underwriter account); each
 * challenge phase records its chalg row id, the escrowed bond, and the
 * balances its resolution is measured against. Cross-step values ride
 * `ctx.outputs` — never shared mutable closures.
 */
export namespace UnderwriterSlashingScenarioOutputs {
  /**
   * A CONFIRMED underwrite commitment under (potential) challenge: the uwreq
   * row id and its winning underwriter's ON-CHAIN account (the `winner`
   * field — already an account name, not a harness label).
   */
  export interface ChallengedCommitment {
    readonly uwreqId: bigint
    readonly underwriterAccount: string
  }

  /** Swap A's quote-computed target amount (lamports). */
  export const swapATargetAmount: OutputKey<bigint> = outputKey(
    "underwriterSlashing.swapA.targetAmount",
    "swap A target amount (lamports) from the ETH→SOL swapquote"
  )
  /** Swap B's quote-computed target amount (lamports). */
  export const swapBTargetAmount: OutputKey<bigint> = outputKey(
    "underwriterSlashing.swapB.targetAmount",
    "swap B target amount (lamports) from the ETH→SOL swapquote"
  )

  /** Swap A's CONFIRMED commitment — the UPHELD challenge's target. */
  export const commitmentA: OutputKey<ChallengedCommitment> = outputKey(
    "underwriterSlashing.commitmentA",
    "swap A's CONFIRMED (uwreq id, winner) — challenged and UPHELD"
  )
  /** Swap B's CONFIRMED commitment — the REJECTED challenge's target. */
  export const commitmentB: OutputKey<ChallengedCommitment> = outputKey(
    "underwriterSlashing.commitmentB",
    "swap B's CONFIRMED (uwreq id, winner) — challenged and REJECTED"
  )

  /** The uphold challenge's `sysio.chalg::uwchals` row id. */
  export const challengeAId: OutputKey<number> = outputKey(
    "underwriterSlashing.challengeA.id",
    "chalg uwchals row id of the UPHELD challenge (commitment A)"
  )
  /** The reject challenge's `sysio.chalg::uwchals` row id. */
  export const challengeBId: OutputKey<number> = outputKey(
    "underwriterSlashing.challengeB.id",
    "chalg uwchals row id of the REJECTED challenge (commitment B)"
  )

  /** The WIRE bond the uphold challenge escrowed (9-decimal units). */
  export const challengeABond: OutputKey<bigint> = outputKey(
    "underwriterSlashing.challengeA.bond",
    "WIRE bond escrowed by the UPHELD challenge"
  )
  /** The WIRE bond the reject challenge escrowed (9-decimal units). */
  export const challengeBBond: OutputKey<bigint> = outputKey(
    "underwriterSlashing.challengeB.bond",
    "WIRE bond escrowed by the REJECTED challenge"
  )

  /** Challenger WIRE balance immediately BEFORE filing the uphold challenge. */
  export const challengerBalanceBeforeA: OutputKey<bigint> = outputKey(
    "underwriterSlashing.challengeA.challengerBalanceBefore",
    "challenger WIRE balance before the UPHELD challenge's escrow"
  )
  /** Challenger WIRE balance immediately BEFORE filing the reject challenge. */
  export const challengerBalanceBeforeB: OutputKey<bigint> = outputKey(
    "underwriterSlashing.challengeB.challengerBalanceBefore",
    "challenger WIRE balance before the REJECTED challenge's escrow"
  )
  /** The wrongly-challenged underwriter's WIRE balance before the reject
   *  challenge — the forfeited bond must land exactly on top of it. */
  export const underwriterBalanceBeforeB: OutputKey<bigint> = outputKey(
    "underwriterSlashing.challengeB.underwriterBalanceBefore",
    "winner's WIRE balance before the REJECTED challenge (forfeit baseline)"
  )
}
