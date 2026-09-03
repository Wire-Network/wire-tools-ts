import Assert from "node:assert"
import type { SysioContracts } from "@wireio/sdk-core"

/**
 * The tier packed into the top two bits of `sysio.system::producer_info.rank_score` — mirrors
 * the contract's `producer_tier`, whose ascending order is the schedule's: healthy producers
 * first, then the bootstrapped backstop, then producers demoted for missed rounds. An UNSCORED
 * row (no ACTIVE `OPERATOR_TYPE_PRODUCER` row in `sysio.opreg` behind it) also sits in the
 * demoted tier, where no consumer's walk ever reaches it.
 */
export enum ProducerTier {
  healthy = 0,
  bootstrapped = 1,
  demoted = 2
}

/** Bits of `rank_score` below the tier — the contract's `tier_bits` (2) off a 64-bit key. */
export const ProducerTierShift = 62n

/**
 * Decode the {@link ProducerTier} a producer's `rank_score` carries.
 *
 * The composite score below the tier is what ranking ORDERS on within a tier, so it is the
 * tier — never the raw key — that says whether collateral moved a producer out of the demoted
 * tier or a demotion moved it in.
 *
 * @param rankScore - The row's `rank_score` (a uint64 the RPC renders as a number or a string).
 * @returns The tier.
 */
export function producerTier(
  rankScore: SysioContracts.SysioSystemProducerInfoType["rank_score"]
): ProducerTier {
  const tier = Number(BigInt(rankScore) >> ProducerTierShift)
  Assert.ok(
    ProducerTier[tier] != null,
    `producerTier: rank_score ${rankScore} carries an unknown tier ${tier}`
  )
  return tier
}
