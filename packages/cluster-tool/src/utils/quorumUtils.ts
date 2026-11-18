/**
 * Numerator of the supermajority fraction a quorum must exceed (2/3): the share of
 * a finalizer policy or a governance authority that must agree.
 */
export const SupermajorityNumerator = 2
/** Denominator of the supermajority fraction (2/3). */
export const SupermajorityDenominator = 3

/**
 * The smallest count STRICTLY more than two thirds of `memberCount` equal-weight
 * members, `floor(2N/3)+1` (15 of 21) — the threshold the chain's finalizer
 * policy and `sysio.councl`'s governance authorities both use.
 *
 * @param memberCount - The number of members, each of weight 1.
 * @returns The threshold.
 */
export function supermajorityThreshold(memberCount: number): number {
  return (
    Math.floor((memberCount * SupermajorityNumerator) / SupermajorityDenominator) + 1
  )
}
