import type { SyndicationRateLimitSnapshot } from "./outputs/index.js"
import { SysioContracts } from "@wireio/sdk-core"
import {
  outputKey,
  ProtocolTiming,
  Steps,
  SyndicationScenario
} from "@wireio/cluster-tool"

/** Token-bucket parameters and exact runtime snapshots. */
export namespace SyndicationRateLimitScenarioConstants {
  /** First arrival, whose item exceeds one burst. */
  export const UserA = {
    account: "synd.usera",
    keypairName: "rate-user-a",
    linked: true
  }
  /** Second arrival. */
  export const UserB = {
    account: "synd.userb",
    keypairName: "rate-user-b",
    linked: true
  }
  /** Syndication burst. */
  export const Burst = 1_000_000_000n
  /** Syndication refill per elapsed second, slow enough that one crank gap refills only part of a burst. */
  export const Refill = 10_000_000n
  /** Seconds an empty bucket takes to refill to the burst. */
  export const FullRefillSec = Number(Burst / Refill)
  /** Wait for a full refill: its seconds, plus one propagation budget for the chain head to reach them. */
  export const FullRefillBudgetMs =
    FullRefillSec * ProtocolTiming.MsPerSecond + ProtocolTiming.SingleHopBudgetMs
  /** The part of A's item past one burst. */
  export const Overflow = 250_000_000n
  /** A's arrival exceeds the initial burst by {@link Overflow}. */
  export const AmountA = Burst + Overflow
  /** B's arrival makes the total exactly twice the burst. */
  export const AmountB = Burst - Overflow
  /** Desyndication burst, less than A's released balance. */
  export const DesyndicationBurst = 500_000_000n
  /** Accepted payout within the desyndication budget. */
  export const DesyndicationAmount = 250_000_000n
  /** Pair rules belong to the scenario's own governance phase. */
  export const Config: SysioContracts.SysioSyndSetconfigAction = {
    chain_code: SyndicationScenario.Chain,
    token_code: SyndicationScenario.Token,
    synd_fee_bps: 0,
    desynd_fee_bps: 0,
    synd_burst: String(Burst),
    synd_refill: String(Refill),
    desynd_burst: String(DesyndicationBurst),
    desynd_refill: 0,
    window_sec: ProtocolTiming.SyndicationChallengeWindowSec,
    bounty: 0,
    challenge_extra: "1000000000",
    min_desyndicate: Steps.registry.MinimumDesyndications[SyndicationScenario.Token],
    desynd_fee_flat: Steps.registry.DesyndicationFlatFees[SyndicationScenario.Token],
    custody_shortfall_bps: 0
  }
  /** Accepted payout after the configured proportional and flat charges. */
  export const DesyndicationNet = DesyndicationAmount - SyndicationScenario.feeOf(
    DesyndicationAmount,
    Config.desynd_fee_bps,
    BigInt(Config.desynd_fee_flat)
  )

  /** A's envelope epoch. */
  export const Epoch = outputKey<number>("rate.epoch", "burst envelope epoch")
  /** Shared request. */
  export const Request = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("rate.request", "burst request")
  /** B's independently observed epoch. */
  export const SecondEpoch = outputKey<number>(
    "rate.secondEpoch",
    "second arrival epoch"
  )
  /** B's independently observed request. */
  export const SecondRequest = outputKey<
    SysioContracts.SysioBondApproveAction["request_id"]
  >("rate.secondRequest", "second arrival request")
  /** Bucket after the initial burst, before any refill. */
  export const FirstBucket = outputKey<SysioContracts.SysioSyndBucketRowType>(
    "rate.firstBucket",
    "bucket after initial release"
  )
  /** Bucket after the partial refill, before the full one. */
  export const RefillBucket = outputKey<SysioContracts.SysioSyndBucketRowType>(
    "rate.refillBucket",
    "bucket after refill release"
  )
  /** Cumulative released amount before the final refill. */
  export const RefillReleased = outputKey<bigint>(
    "rate.refillReleased",
    "released after first refill"
  )
  /** Expected refusal, verified separately. */
  export const Refusal = outputKey<string>(
    "rate.refusal",
    "desyndication refusal"
  )
  /** Redemption accounting snapshot. */
  export const BeforeDesyndication = outputKey<SyndicationRateLimitSnapshot>(
    "rate.beforeDesyndication",
    "redemption baseline"
  )
  /** Destination token balance before the accepted return. */
  export const ExternalBalanceBefore = outputKey<bigint>(
    "rate.externalBalanceBefore",
    "external redemption baseline"
  )
}
