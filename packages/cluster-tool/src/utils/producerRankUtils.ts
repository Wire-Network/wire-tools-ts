import Assert from "node:assert"
import { match, P } from "ts-pattern"

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
 * Widen a `rank_score` to `bigint` without letting a lossy JSON rendering pass silently.
 *
 * `rank_score` is a uint64 and every non-healthy tier sets bit 62 or 63, so any tiered value is
 * far above `Number.MAX_SAFE_INTEGER`. A `number` at that magnitude has already lost precision
 * before this function is reached — the demoted tier's `unscored()`
 * (`0xBFFFFFFFFFFFFFFF`) rounds UP into `0xC000000000000000`, whose top two bits read as an
 * unknown tier 3. The depot quotes integers above `0xffffffff`, so a `number` here means the
 * value arrived from something that did not, and the only safe response is to say so rather
 * than decode a corrupted key.
 *
 * @param rankScore - The row's `rank_score`, as the RPC rendered it.
 * @returns The exact score.
 */
function toRankScore(rankScore: SysioContracts.SysioSystemProducerInfoType["rank_score"]): bigint {
  return match(rankScore)
    .with(P.string, value => BigInt(value))
    .with(P.number, value => {
      Assert.ok(
        Number.isSafeInteger(value),
        `producerTier: rank_score ${value} exceeds the safe-integer range as a number, so its ` +
          `tier bits are already lost — it must arrive as a string`
      )
      return BigInt(value)
    })
    .exhaustive()
}

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
  const tier = Number(toRankScore(rankScore) >> ProducerTierShift)
  Assert.ok(
    ProducerTier[tier] != null,
    `producerTier: rank_score ${rankScore} carries an unknown tier ${tier}`
  )
  return tier
}
